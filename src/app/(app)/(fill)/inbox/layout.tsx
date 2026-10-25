import { ListPane } from "./list-pane";
import { ThreadSlot } from "./thread-slot";

export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0">
      <ListPane />
      <ThreadSlot>{children}</ThreadSlot>
    </div>
  );
}
