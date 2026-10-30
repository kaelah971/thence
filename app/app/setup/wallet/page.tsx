import type { Metadata } from "next";
import { WalletSetup } from "@/ui/screens/setup/WalletSetup";

export const metadata: Metadata = { title: "Connect your wallet" };

export default function WalletSetupPage(): React.JSX.Element {
  return <WalletSetup />;
}
