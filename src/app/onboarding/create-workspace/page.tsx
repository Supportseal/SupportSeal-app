import { redirect } from "next/navigation";

export const metadata = { title: "Create your Workspace" };

export default function CreateWorkspacePage() {
  // The setup wizard owns workspace creation; this route stays as a redirect
  // for old links.
  redirect("/onboarding");
}
