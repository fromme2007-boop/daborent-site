import { createClient } from 'npm:@supabase/supabase-js@2';

/**
 * decentro-webhook
 *
 * Receives Decentro UPI Collections transaction callbacks and settles the
 * matching charge: marks the charge_payments row paid and rolls the amount
 * into charges.amount_paid / status.
 *
 * Auth: Decentro sends a shared secret header configured when the callback
 * is registered in their dashboard. Header name is configurable there — this
 * function reads x-decentro-secret and Authorization: Bearer as candidates.
 *
 * FIELD SHAPES cross-checked against the Collections v3 Status Callback
 * reference (30 Jul 2026): flat body with reference_id, transaction_status
 * (PENDING/SUCCESS/FAILED/EXPIRED/DEEMED/REFUND_FAILED/REFUNDED/
 * DISPUTED_AMOUNT), transaction_amount, bank_reference_number, npci_txn_id,
 * payer_vpa, payer_name, decentro_txn_id. Refund/dispute statuses are stored
 * raw and ignored for now. Raw payloads always land in payment_gateway_events
 * before parsing, so a surprise shape loses nothing. Final confirmation with
 * one real staging callback is still pending.
 */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getRequiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

type ParsedCallback = {
  referenceId: string | null;
  decentroTxnId: string | null;
  status: string;
  amount: number | null;
  payerVpa: string | null;
  utr: string | null;
};

function parseCallback(payload: Record<string, unknown>): ParsedCallback {
  const inner = (payload?.data ?? payload) as Record<string, unknown>;
  const attributes = (inner?.attributes ?? inner) as Record<string, unknown>;

  const rawStatus = String(
    inner?.transaction_status ?? inner?.status ?? attributes?.status ?? ''
  ).toUpperCase();

  return {
    referenceId:
      (inner?.reference_id ?? attributes?.reference_id ?? payload?.reference_id ?? null) as
        | string
        | null,
    decentroTxnId:
      (payload?.decentro_txn_id ?? inner?.decentro_txn_id ?? null) as string | null,
    status: rawStatus,
    amount:
      inner?.transaction_amount != null
        ? Number(inner.transaction_amount)
        : inner?.amount != null
        ? Number(inner.amount)
        : null,
    payerVpa: (inner?.payer_vpa ?? attributes?.payer_vpa ?? null) as string | null,
    utr: (inner?.bank_reference_number ?? inner?.utr ?? attributes?.utr ?? null) as
      | string
      | null,
  };
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405);
  }

  try {
    const webhookSecret = getRequiredEnv('DECENTRO_WEBHOOK_SECRET');
    const headerSecret =
      request.headers.get('x-decentro-secret') ??
      (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');

    if (!headerSecret || headerSecret !== webhookSecret) {
      return jsonResponse({ error: 'Unauthorized.' }, 401);
    }

    const payload = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!payload) return jsonResponse({ error: 'Invalid JSON.' }, 400);

    const supabaseUrl = getRequiredEnv('SUPABASE_URL');
    const serviceRoleKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // Store the raw event before any parsing, so a schema surprise loses nothing.
    await adminClient.from('payment_gateway_events').insert({
      provider: 'decentro',
      event_type: 'upi_collection_callback',
      payload,
    });

    const parsed = parseCallback(payload);

    if (!parsed.referenceId) {
      return jsonResponse({ ok: true, note: 'No reference_id; stored raw only.' });
    }

    const isSuccess = ['SUCCESS', 'COMPLETED', 'PAID'].includes(parsed.status);
    const isFailure = ['FAILURE', 'FAILED', 'EXPIRED', 'DECLINED'].includes(parsed.status);

    const { data: paymentRow } = await adminClient
      .from('charge_payments')
      .select('id, charge_id, tenant_id, amount, status')
      .eq('provider', 'decentro')
      .eq('reference_number', parsed.referenceId)
      .limit(1)
      .maybeSingle();

    if (!paymentRow) {
      return jsonResponse({ ok: true, note: 'No matching payment row; stored raw only.' });
    }

    if (paymentRow.status === 'paid') {
      return jsonResponse({ ok: true, note: 'Already settled (duplicate callback).' });
    }

    if (isFailure) {
      await adminClient
        .from('charge_payments')
        .update({
          status: 'failed',
          metadata: {
            decentro_txn_id: parsed.decentroTxnId,
            callback_status: parsed.status,
          },
        })
        .eq('id', paymentRow.id);
      return jsonResponse({ ok: true, result: 'failed' });
    }

    if (!isSuccess) {
      return jsonResponse({ ok: true, note: `Ignored status ${parsed.status}.` });
    }

    const paidAmount = parsed.amount ?? Number(paymentRow.amount);

    await adminClient
      .from('charge_payments')
      .update({
        status: 'paid',
        paid_at: new Date().toISOString(),
        metadata: {
          decentro_txn_id: parsed.decentroTxnId,
          payer_vpa: parsed.payerVpa,
          utr: parsed.utr,
          callback_status: parsed.status,
          amount_from_callback: parsed.amount,
        },
      })
      .eq('id', paymentRow.id);

    // Roll the payment into the charge, mirroring the Razorpay-era settlement.
    const { data: charge } = await adminClient
      .from('charges')
      .select('id, amount, amount_paid, late_fee, status')
      .eq('id', paymentRow.charge_id)
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

    return jsonResponse({ ok: true, result: 'settled', payment_id: paymentRow.id });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : 'Unknown webhook error.' },
      500
    );
  }
});
