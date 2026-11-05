import { BottomNav } from "@/ui/components/BottomNav";
import { ForegroundRefresh } from "@/ui/components/ForegroundRefresh";
import { PreviewBanner } from "@/ui/components/PreviewBanner";
import { SessionGuard } from "@/ui/components/SessionGuard";
import styles from "@/ui/components/shell.module.css";

export default function TabsLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <SessionGuard>
      <ForegroundRefresh />
      <div className={styles.frameContent}>
        <PreviewBanner />
        {children}
      </div>
      <BottomNav />
    </SessionGuard>
  );
}
