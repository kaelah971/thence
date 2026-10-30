import type { Metadata } from "next";
import { PublicRequest } from "@/ui/screens/requests/PublicRequest";

export const metadata: Metadata = { title: "Payment request" };

export default async function PublicRequestPage({ params }: { params: Promise<{ publicId: string }> }): Promise<React.JSX.Element> {
  const { publicId } = await params;
  return <PublicRequest publicId={publicId} />;
}
