/**
 * create-payment-template-v2 — one-shot helper to submit (and then check)
 * the post-Razorpay WhatsApp template `tenant_payment_due_v2`.
 *
 * v1 (`tenant_payment_due_v1`) has a Meta-approved URL button hardcoded to
 * https://rzp.io/rzp/ and that button parameter is mandatory, so it cannot be
 * sent at all now that Razorpay is closed. v2 carries the payment instruction
 * in the body text instead and has NO buttons.
 *
 *   GET  ?action=check   -> list templates on the WABA with their review status
 *   POST                 -> submit tenant_payment_due_v2 for review
 *
 * Both actions require the x-cron-secret header so this cannot be used by
 * anyone who merely knows the URL to create templates on the business account.
 *
 * Safe to delete once v2 is APPROVED.
 */

const WABA_ID = Deno.env.get('WHATSAPP_BUSINESS_ACCOUNT_ID') ?? '1336192051737341';
const TEMPLATE_NAME = 'tenant_payment_due_v2';

const BODY_TEXT = [
  'Hi {{1}}, this is a payment reminder for {{2}}.',
  'Your {{3}} payment of ₹{{4}} is due on {{5}}.',
  'To pay, open the DaboRent app or send the amount by UPI to {{6}}.',
].join('\n');

const BODY_EXAMPLE = [
  'Ramesh',
  'Room 7',
  'Rent',
  '5500.00',
  '09/08/2026',
  'cordeliabbarreto-1@oksbi',
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  const accessToken = Deno.env.get('WHATSAPP_ACCESS_TOKEN') ?? '';
  const cronSecret = Deno.env.get('WHATSAPP_CRON_SECRET') ?? '';

  if (!accessToken) {
    return jsonResponse({ error: 'WHATSAPP_ACCESS_TOKEN is not configured.' }, 500);
  }

  if (!cronSecret || req.headers.get('x-cron-secret') !== cronSecret) {
    return jsonResponse({ error: 'Unauthorized.' }, 401);
  }

  const authHeaders = { Authorization: `Bearer ${accessToken}` };
  const url = new URL(req.url);

  // ── CHECK: list every template and its review status ──────────────────────
  if (req.method === 'GET' || url.searchParams.get('action') === 'check') {
    const res = await fetch(
      `https://graph.facebook.com/v25.0/${WABA_ID}/message_templates?fields=name,status,category,language,rejected_reason&limit=50`,
      { headers: authHeaders }
    );
    const data = await res.json().catch(() => ({}));

    const templates = (data as { data?: { name: string }[] })?.data ?? [];
    const v2 = templates.find((t) => t.name === TEMPLATE_NAME) ?? null;

    return jsonResponse(
      { waba_id: WABA_ID, v2_present: Boolean(v2), v2, templates },
      res.ok ? 200 : res.status
    );
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405);
  }

  // ── CREATE: submit v2 for review ──────────────────────────────────────────
  const payload = {
    name: TEMPLATE_NAME,
    language: 'en',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: BODY_TEXT,
        example: { body_text: [BODY_EXAMPLE] },
      },
    ],
  };

  const res = await fetch(
    `https://graph.facebook.com/v25.0/${WABA_ID}/message_templates`,
    {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );

  const result = await res.json().catch(() => ({}));

  return jsonResponse(
    { submitted: res.ok, waba_id: WABA_ID, request: payload, response: result },
    res.status
  );
});
