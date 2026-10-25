import Customer from "@/lib/models/Customer";
import Order from "@/lib/models/Order";
import { connectToDB } from "@/lib/mongoDB";
import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";

// Typed like the removed field under old stripe types, like the new location under new ones.
type CheckoutShippingDetails<T> = T extends { shipping_details: infer S }
  ? S
  : T extends { collected_information: infer C }
    ? NonNullable<C> extends { shipping_details: infer S }
      ? S | null
      : null
    : null;

// The old top-level field when present (old-version payloads), otherwise
// collected_information.shipping_details, which holds only address and name.
function getCheckoutShippingDetails<T extends object>(session: T): CheckoutShippingDetails<T> {
  const legacy: unknown = Reflect.get(session, 'shipping_details');
  const collected: unknown = Reflect.get(session, 'collected_information');
  const moved: unknown =
    collected && typeof collected === 'object' ? Reflect.get(collected, 'shipping_details') : undefined;
  return (legacy !== undefined ? legacy : (moved ?? null)) as CheckoutShippingDetails<T>;
}

export const POST = async (req: NextRequest) => {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("Stripe-Signature") as string;

    const event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const customerInfo = {
        clerkId: session?.client_reference_id,
        name: session?.customer_details?.name,
        email: session?.customer_details?.email,
      };

      const shippingAddress = {
        street: (session == null ? undefined : getCheckoutShippingDetails(session))?.address?.line1,
        city: (session == null ? undefined : getCheckoutShippingDetails(session))?.address?.city,
        state: (session == null ? undefined : getCheckoutShippingDetails(session))?.address?.state,
        postalCode: (session == null ? undefined : getCheckoutShippingDetails(session))?.address?.postal_code,
        country: (session == null ? undefined : getCheckoutShippingDetails(session))?.address?.country,
      };

      const retrieveSession = await stripe.checkout.sessions.retrieve(
        session.id,
        { expand: ["line_items.data.price.product"] }
      );

      const lineItems = await retrieveSession?.line_items?.data;

      const orderItems = lineItems?.map((item: any) => {
        return {
          product: item.price.product.metadata.productId,
          color: item.price.product.metadata.color || "N/A",
          size: item.price.product.metadata.size || "N/A",
          quantity: item.quantity,
        };
      });

      await connectToDB();

      const newOrder = new Order({
        customerClerkId: customerInfo.clerkId,
        products: orderItems,
        shippingAddress,
        shippingRate: session?.shipping_cost?.shipping_rate,
        totalAmount: session.amount_total ? session.amount_total / 100 : 0,
      });

      await newOrder.save();

      let customer = await Customer.findOne({ clerkId: customerInfo.clerkId });

      if (customer) {
        customer.orders.push(newOrder._id);
      } else {
        customer = new Customer({
          ...customerInfo,
          orders: [newOrder._id],
        });
      }

      await customer.save();
    }

    return new NextResponse("Pedido criado com sucesso", { status: 200 });
  } catch (err) {
    console.log("[webhooks_POST]", err);
    return new NextResponse("Erro ao criar pedido", { status: 500 });
  }
};
