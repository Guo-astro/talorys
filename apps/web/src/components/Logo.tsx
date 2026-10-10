import { cn } from "../lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn("h-7 w-7", className)} aria-hidden>
      <rect width="64" height="64" rx="16" className="fill-brand-700 dark:fill-brand-500" />
      <path d="M20 22h24M32 22v22" stroke="white" strokeWidth="6" strokeLinecap="round" />
      <circle cx="44" cy="44" r="4" className="fill-brand-200" />
    </svg>
  );
}
