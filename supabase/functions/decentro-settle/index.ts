import { createClient } from 'npm:@supabase/supabase-js@2';

/**
 * decentro-settle — status-poll settlement for Decentro UPI collections.
 *
 * The webhook was never registered with Decentro, so this is the primary
 * settlement path: poll GET /v3/payments/transaction/status and settle the
 * charge exactly the way decentro-webhook would have.
 *
 * Two entry modes:
 *  - TENANT (Authorization JWT + body {payment_id}): the app calls this right
 *    after the tenant returns from the payment page, for instant confirmation.
 *    The payment must belong to the calling tenant.
 *  - SWEEP (x-cron-secret header, no JWT): processes all decentro rows with
 *    status 'created' older than 3 minutes, so payments settle even if the
 *    tenant closed the app. Wired to a pg_cron job every 10 minutes.
 *
 * Lookups use decentro_txn_id ONLY — never reference_id, which fails with
 * "Multiple records found" when a reference was reused by retries.
 *
 * Status API verified against live staging (30 Jul 2026):
 *   GET {base}/v3/payments/transaction/status?decentro_txn_id=<id>
 *   headers: client_id, client_secret, User-Agent (nginx 403s without it)
 *   200: { api_status: "SUCCESS", data: { transaction_status,
 *          bank_reference_number, npci_txn_id, reference_id, ... } }
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** Required — Decentro's edge rejects requests with no User-Agent (403). */
const USER_AGENT = 'DaboRent/1.0 (+https://fromme2007-boop.github.io/daborent-privacy/)';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getRequiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

type PaymentRow = {
  id: string;
  charge_id: string;
  tenant_id: string;
  amount: number | string;
  status: string;
  metadata: Record<string, unknown> | null;
};

type StatusResult = {
  ok: boolean;
  status: string;
  utr: string | null;
  npciTxnId: string | null;
  raw: Record<string, unknown>;
};

async function fetchDecentroStatus(decentroTxnId: string): Promise<StatusResult> {
  const baseUrl = getRequiredEnv('DECENTRO_BASE_URL');
  const response = await fetch(
    `${baseUrl}/v3/payments/transaction/status?decentro_txn_id=${encodeURIComponent(decentroTxnId)}`,
    {
      headers: {
        // MUST be present — Decentro's nginx 403s requests with no User-Agent.
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        client_id: getRequiredEnv('DECENTRO_CLIENT_ID'),
        client_secret: getRequiredEnv('DECENTRO_CLIENT_SECRET'),
      },
    }
  );

  const rawBody = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    data = { parse_error: rawBody.slice(0, 300) };
  }

  const inner = (data?.data ?? {}) as Record<string, unknown>;

  return {
    ok: response.ok && data?.api_status === 'SUCCESS',
    status: String(inner?.transaction_status ?? '').toUpperCase(),
    utr: (inner?.bank_reference_number ?? null) as string | null,
    npciTxnId: (inner?.npci_txn_id ?? null) as string | null,
    raw: data,
  };
}

/** Settle one payment row against its polled status. Idempotent. */
async function settlePayment(
  adminClient: ReturnType<typeof createClient>,
  payment: PaymentRow
): Promise<Record<string, unknown>> {
  if (payment.status === 'paid') {
    return { payment_id: payment.id, result: 'already_paid' };
  }

  const decentroTxnId =
    (payment.metadata?.decentro_txn_id as string | undefined) ?? null;
  if (!decentroTxnId) {
    return { payment_id: payment.id, result: 'skipped', reason: 'No decentro_txn_id in metadata.' };
  }

  const polled = await fetchDecentroStatus(decentroTxnId);

  if (!polled.ok) {
    return {
      payment_id: payment.id,
      result: 'poll_failed',
      details: polled.raw?.message ?? polled.raw,
    };
  }

  const isSuccess = polled.status === 'SUCCESS';
  const isTerminalFailure = ['FAILED', 'FAILURE', 'EXPIRED'].includes(polled.status);

  if (isTerminalFailure) {
    await adminClient
      .from('charge_payments')
      .update({
        status: 'failed',
        metadata: {
          ...(payment.metadata ?? {}),
          polled_status: polled.status,
          settled_via: 'status_poll',
        },
      })
      .eq('id', payment.id)
      .eq('status', 'created');
    return { payment_id: payment.id, result: 'failed', transaction_status: polled.status };
  }

  if (!isSuccess) {
    // PENDING or anything unexpected — leave for the next sweep.
    return { payment_id: payment.id, result: 'pending', transaction_status: polled.status };
  }

  const { data: updatedPayment } = await adminClient
    .from('charge_payments')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      metadata: {
        ...(payment.metadata ?? {}),
        utr: polled.utr,
        npci_txn_id: polled.npciTxnId,
        polled_status: polled.status,
        settled_via: 'status_poll',
      },
    })
    .eq('id', payment.id)
    .eq('status', 'created') // guard against a concurrent webhook/sweep settling it
    .select('id')
    .maybeSingle();

  if (!updatedPayment) {
    return { payment_id: payment.id, result: 'already_paid' };
  }

  const paidAmount = Number(payment.amount || 0);

  const { data: charge } = await adminClient
    .from('charges')
    .select('id, amount, amount_paid, late_fee, status')
    .eq('id', payment.charge_id)
    .maybeSingle();

  if (charge && charge.status !== 'paid' && charge.status !== 'cancelled') {
    const lateFee = Math.max(Number(charge.late_fee || 0), 0);
    const totalOwed = Number(charge.amount || 0) + lateFee;
    const newPaid = Math.min(Number(charge.amount_paid || 0) + paidAmount, totalOwed);
    const newStatus = newPaid >= totalOwed ? 'paid' : 'partially_paid';

    await adminClient
      .from('charges')
      .update({
        amount_paid: newPaid,
        status: newStatus,
        paid_at: newStatus === 'paid' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', charge.id);
  }

  return {
    payment_id: payment.id,
    result: 'settled',
    transaction_status: polled.status,
    utr: polled.utr,
    npci_txn_id: polled.npciTxnId,
  };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  try {
    const supabaseUrl = getRequiredEnv('SUPABASE_URL');
    const serviceRoleKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // ── SWEEP mode: cron secret, no JWT ─────────────────────────────────────
    const cronSecret = Deno.env.get('WHATSAPP_CRON_SECRET') ?? '';
    const requestCronSecret = request.headers.get('x-cron-secret') ?? '';

    if (cronSecret && requestCronSecret === cronSecret) {
      const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();

      const { data: pendingRows, error } = await adminClient
        .from('charge_payments')
        .select('id, charge_id, tenant_id, amount, status, metadata')
        .eq('provider', 'decentro')
        .eq('status', 'created')
        .lt('created_at', threeMinutesAgo)
        .order('created_at', { ascending: true })
        .limit(25);

      if (error) {
        return jsonResponse({ error: `Sweep query failed: ${error.message}` }, 500);
      }

      const results: Record<string, unknown>[] = [];
      for (const row of (pendingRows ?? []) as PaymentRow[]) {
        try {
          results.push(await settlePayment(adminClient, row));
        } catch (err) {
          results.push({
            payment_id: row.id,
            result: 'error',
            reason: err instanceof Error ? err.message : 'Unknown error',
          });
        }
      }

      return jsonResponse({
        ok: true,
        mode: 'sweep',
        checked: results.length,
        settled: results.filter((r) => r.result === 'settled').length,
        results,
      });
    }

    // ── TENANT mode: JWT + payment_id ───────────────────────────────────────
    const authHeader = request.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Missing authorization token.' }, 401);
    }

    const anonKey = getRequiredEnv('SUPABASE_ANON_KEY');
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return jsonResponse({ error: 'Unauthorized.' }, 401);

    const body = await request.json().catch(() => ({}));
    const paymentId = typeof body.payment_id === 'string' ? body.payment_id : null;
    if (!paymentId) return jsonResponse({ error: 'payment_id is required.' }, 400);

    const { data: tenant } = await adminClient
      .from('tenants')
      .select('id')
      .eq('profile_id', user.id)
      .eq('is_active', true)
      .maybeSingle();
    if (!tenant) return jsonResponse({ error: 'No active tenant for this login.' }, 403);

    const { data: payment } = await adminClient
      .from('charge_payments')
      .select('id, charge_id, tenant_id, amount, status, metadata')
      .eq('id', paymentId)
      .eq('provider', 'decentro')
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (!payment) return jsonResponse({ error: 'Payment not found.' }, 404);

    const result = await settlePayment(adminClient, payment as PaymentRow);
    return jsonResponse({ ok: true, mode: 'tenant', ...result });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : 'Unknown settle error.' },
      500
    );
  }
});
