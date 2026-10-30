import styles from "@/ui/components/shell.module.css";

export default function TabTemplate({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className={styles.enter}>{children}</div>;
}
