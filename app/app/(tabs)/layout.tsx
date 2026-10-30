import { BottomNav } from "@/ui/components/BottomNav";
import { PreviewBanner } from "@/ui/components/PreviewBanner";
import { SessionGuard } from "@/ui/components/SessionGuard";
import styles from "@/ui/components/shell.module.css";

export default function TabsLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <SessionGuard>
      <div className={styles.frameContent}>
        <PreviewBanner />
        {children}
      </div>
      <BottomNav />
    </SessionGuard>
  );
}
