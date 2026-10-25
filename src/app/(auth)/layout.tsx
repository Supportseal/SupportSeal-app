import { Logo } from "@/components/layout/logo";
import { brand } from "@/lib/brand";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen bg-body-bg lg:grid-cols-2">
      <div className="relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between p-10">
        <Logo />
        <div className="relative z-10 max-w-md">
          <h2 className="text-[2rem] font-semibold text-heading">
            One support desk for everything you build
          </h2>
          <p className="mt-3 text-body">
            Live chat and support email for every product, one inbox, and the
            application context developers actually need.
          </p>
        </div>
        <svg className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 640 800" aria-hidden>
          <circle cx="460" cy="150" r="150" fill="var(--vx-primary)" opacity="0.12" />
          <circle cx="80" cy="660" r="200" fill="var(--vx-primary)" opacity="0.1" />
          <rect x="60" y="300" width="220" height="200" rx="24" fill="var(--vx-surface)" />
          <rect x="84" y="332" width="172" height="16" rx="8" fill="var(--vx-primary-label)" />
          <rect x="84" y="368" width="132" height="12" rx="6" fill="var(--vx-border)" />
          <rect x="84" y="400" width="172" height="72" rx="12" fill="var(--vx-primary)" opacity="0.35" />
          <circle cx="240" cy="280" r="36" fill="var(--vx-primary)" />
        </svg>
        <p className="relative z-10 text-sm text-muted">{brand.tagline}</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-[26.5rem]">{children}</div>
      </div>
    </div>
  );
}
