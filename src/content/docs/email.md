# Support email

Customers write to the address they already know, for example
`support@yourproduct.com`. {{name}} turns each message into a Conversation.

## How it flows

1. **Settings → Products → your Product → Email** shows a generated inbound
   address such as `product_xxx@inbound.example.com`.
2. In your mail provider, forward `support@yourproduct.com` to that address.
3. New mail appears in the **Inbox** under that Product.
4. Your reply is sent from `"Your Product Support" <no-reply@…>` with a
   reply-to that threads the customer's answer back into the same Conversation.

No DNS changes are needed for the generated address. Send a test email to confirm.

## Custom mail domain (optional)

To receive mail at any address of a dedicated (sub)domain, choose **Show DNS
records** on the Email tab. Add the MX and TXT records shown, then **Verify
records**. Verified domains are a catch-all for that one Product. DNS can take
minutes to propagate; chat and the generated address keep working meanwhile.

## Support address and mail loops (optional)

Set the Product's **Support address** to the address customers write to. It is
shown in the widget and used as a loop guard: {{name}} never mails it, and
ignores auto-responses and its own messages. Ignored mail is listed in the delivery log.

## Self-hosted installs

Self-hosters must first configure an inbound webhook and an outbound provider
(SendGrid or SMTP). See [Self-hosting](/docs/self-hosting#support-email).
