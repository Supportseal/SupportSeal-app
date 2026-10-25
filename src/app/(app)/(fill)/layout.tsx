import { Shell } from "../shell-data";

export default async function FillLayout({ children }: { children: React.ReactNode }) {
  return <Shell mode="fill">{children}</Shell>;
}
