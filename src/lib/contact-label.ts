/** Client-safe display name for a Contact: name, else email, else a stable "Visitor ABCD". */
export function visitorLabel(contact: { id: string; email: string | null; name: string | null }) {
  if (contact.name?.trim()) return contact.name.trim();
  if (contact.email) return contact.email;
  return `Visitor ${(contact.id.replace(/[^a-z0-9]/gi, "").slice(-4) || "0000").toUpperCase()}`;
}
