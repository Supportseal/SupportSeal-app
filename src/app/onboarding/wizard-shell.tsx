import Link from "next/link";
import { brand } from "@/lib/brand";
import { Logo } from "@/components/layout/logo";

import { SignOutLink } from "./sign-out-link";

const STEPS = ["Workspace", "Product", "Domain", "Mail", "Install"] as const;

/** Focused wizard shell (no sidebar) per docs/design/onboarding.md. */
export function WizardShell({
  step,
  heading,
  children,
}: {
  step: number;
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-body-bg">
      <header className="mx-auto flex max-w-2xl items-center justify-between px-6 py-5">
        <Logo />
        <SignOutLink />
      </header>
      <main className="mx-auto max-w-2xl px-6 pb-16">
        <ol className="mb-8 flex items-center gap-1 sm:gap-2" aria-label="Setup steps">
          {STEPS.map((label, index) => {
            const number = index + 1;
            const state = number < step ? "done" : number === step ? "current" : "todo";
            return (
              <li key={label} className="flex items-center gap-2" aria-current={state === "current" ? "step" : undefined}>
                <span
                  aria-hidden
                  className={`flex size-7 items-center justify-center rounded-full text-xs font-semibold ${
                    state === "done"
                      ? "bg-success-label text-success"
                      : state === "current"
                        ? "bg-primary text-primary-contrast"
                        : "bg-surface-2 text-muted"
                  }`}
                >
                  {state === "done" ? "✓" : number}
                </span>
                <span className={`text-sm ${state === "current" ? "font-medium text-heading" : "sr-only text-muted sm:not-sr-only"}`}>
                  {label}
                </span>
                {number < STEPS.length ? <span className="mx-1 hidden h-px w-6 bg-border sm:block" aria-hidden /> : null}
              </li>
            );
          })}
        </ol>
        <h1 className="mb-1 text-2xl font-semibold text-heading">{heading}</h1>
        <p className="mb-6 text-sm text-muted">
          A few quick steps to your first {brand.name} conversation.
        </p>
        {children}
      </main>
    </div>
  );
}

function Submit({ label }: { label: string }) {
  return (
    <button
      type="submit"
      className="h-10 rounded-md bg-primary px-5 text-sm font-medium text-primary-contrast hover:bg-primary-dark"
    >
      {label}
    </button>
  );
}

WizardShell.Submit = Submit;

export { Link };
