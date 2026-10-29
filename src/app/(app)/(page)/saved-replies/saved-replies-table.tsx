"use client";

import { useTransition } from "react";
import { IconTrash } from "@tabler/icons-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { deleteSavedReplyAction } from "./actions";

type Reply = { id: string; name: string; body: string; productNames: string[] };

export function SavedRepliesTable({ replies, isAdmin }: { replies: Reply[]; isAdmin: boolean }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="rounded-lg border border-border">
      <table className="w-full text-sm max-sm:block">
        <thead className="max-sm:hidden">
          <tr className="border-b border-border text-left text-muted">
            <th className="px-4 py-3 font-medium">Name</th>
            <th className="px-4 py-3 font-medium">Available in</th>
            <th className="px-4 py-3 font-medium">Body</th>
            {isAdmin ? <th className="px-4 py-3" /> : null}
          </tr>
        </thead>
        <tbody className="max-sm:block">
          {replies.map((reply) => (
            <tr
              key={reply.id}
              className="border-b border-border align-top last:border-0 max-sm:block max-sm:space-y-2 max-sm:p-4"
            >
              <td className="px-4 py-3 font-medium text-heading max-sm:block max-sm:p-0">{reply.name}</td>
              <td className="px-4 py-3 max-sm:block max-sm:p-0">
                <div className="flex max-w-48 flex-wrap max-sm:max-w-none gap-1">
                  {reply.productNames.length === 0 ? (
                    <Badge variant="light" color="secondary">
                      All products
                    </Badge>
                  ) : (
                    reply.productNames.map((name) => (
                      <Badge key={name} variant="light" color="primary">
                        {name}
                      </Badge>
                    ))
                  )}
                </div>
              </td>
              <td className="max-w-md px-4 py-3 text-body max-sm:block max-sm:max-w-none max-sm:p-0">
                <p className="line-clamp-2 whitespace-pre-wrap">{reply.body}</p>
              </td>
              {isAdmin ? (
                <td className="px-4 py-3 text-right max-sm:block max-sm:p-0 max-sm:text-left">
                  <form
                    action={(formData) =>
                      startTransition(() => deleteSavedReplyAction(formData))
                    }
                  >
                    <input type="hidden" name="id" value={reply.id} />
                    <Button type="submit" variant="text" color="danger" size="xs" disabled={pending}>
                      <IconTrash className="size-3.5" />
                      Delete
                    </Button>
                  </form>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
