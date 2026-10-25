import { Shell } from "../shell-data";

export default async function PageLayout({ children }: { children: React.ReactNode }) {
  return <Shell mode="page">{children}</Shell>;
}
