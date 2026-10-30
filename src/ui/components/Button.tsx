import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/ui/lib/cn";
import { Icon, type IconName } from "./Icon";
import styles from "./primitives.module.css";

export type ButtonVariant = "light" | "ink" | "dark" | "soft" | "ghost" | "mint";
export type ButtonSize = "lg" | "md" | "sm";

interface CommonProps {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  icon?: IconName | undefined;
  trailingIcon?: IconName | undefined;
  block?: boolean | undefined;
  className?: string | undefined;
  children: ReactNode;
}

type ButtonProps = CommonProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">;
type LinkProps = CommonProps & { href: string; "aria-label"?: string; onClick?: () => void };

function classes({ variant = "ink", size = "lg", block, className }: CommonProps): string {
  return cn(styles.button, styles[`v-${variant}`], styles[`s-${size}`], block && styles.block, className);
}

function Inner({ icon, trailingIcon, size = "lg", children }: CommonProps): React.JSX.Element {
  const iconSize = size === "sm" ? 16 : 18;
  return (
    <>
      {icon && <Icon name={icon} size={iconSize} />}
      <span className={styles.label}>{children}</span>
      {trailingIcon && <Icon name={trailingIcon} size={iconSize} />}
    </>
  );
}

export function Button(props: ButtonProps): React.JSX.Element {
  const { variant, size, icon, trailingIcon, block, className, children, type = "button", ...rest } = props;
  return (
    <button type={type} className={classes({ variant, size, block, className, children })} {...rest}>
      <Inner icon={icon} trailingIcon={trailingIcon} size={size}>
        {children}
      </Inner>
    </button>
  );
}

export function ButtonLink(props: LinkProps): React.JSX.Element {
  const { variant, size, icon, trailingIcon, block, className, children, href, ...rest } = props;
  return (
    <Link href={href} className={classes({ variant, size, block, className, children })} {...rest}>
      <Inner icon={icon} trailingIcon={trailingIcon} size={size}>
        {children}
      </Inner>
    </Link>
  );
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className"> {
  icon: IconName;
  label: string;
  tone?: "dark" | "light";
  className?: string | undefined;
}

export function IconButton({ icon, label, tone = "dark", className, type = "button", ...rest }: IconButtonProps): React.JSX.Element {
  return (
    <button type={type} aria-label={label} className={cn(styles.iconButton, styles[`ib-${tone}`], className)} {...rest}>
      <Icon name={icon} size={20} />
    </button>
  );
}
