import { createClient } from 'npm:@supabase/supabase-js@2';

/**
 * create-decentro-payment-link
 *
 * Creates a Decentro UPI Collections v3 payment link for a charge, so the
 * tenant can pay via intent/QR into a merchant-class virtual account.
 * (NPCI risk policy blocks intent links to personal VPAs — verified 30 Jul
 * 2026 on PhonePe and Paytm — which is why collections go through Decentro.)
 *
 * Called by the app with the tenant's JWT. The tenant must own the charge.
 *
 * FIELD SHAPES VERIFIED against live staging on 30 Jul 2026
 * (decentro_txn_id A884FD698ED246AE870ABEB396B3522E):
 *   POST https://staging.api.decentro.tech/v3/payments/upi/link
 *   headers: client_id, client_secret            (no module secret on the PA stack)
 *   body:    reference_id, consumer_urn, amount, purpose_message,
 *            expiry_time (1..1440 minutes), generate_uri
 *   200 OK:  { api_status: "SUCCESS", decentro_txn_id,
 *              data: { upi_uris: { common_uri }, transaction_status: "PENDING" } }
 * Production base URL is https://api.decentro.tech (same paths).
 *
 * ⚠️ 31 Jul 2026 — Decentro's nginx returns a bare 403 (HTML, no JSON body) to
 * any request WITHOUT a User-Agent header. Deno's fetch sends none by default,
 * so every call from this edge function was blocked before reaching their API.
 * Verified by A/B test: same credentials, UA present -> reaches API;
 * UA absent -> 403 Forbidden HTML. Always send USER_AGENT below.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

function createReferenceId(chargeId: string) {
  const compact = chargeId.replace(/-/g, '').slice(0, 24);
  const timestamp = Date.now().toString().slice(-10);
  return `DBR${compact}${timestamp}`;
}

function buildDecentroRequest(params: {
  referenceId: string;
  amount: number;
  purposeMessage: string;
}) {
  // Consumer URN is issued by Decentro before go-live; staging value differs.
  const consumerUrn = getRequiredEnv('DECENTRO_CONSUMER_URN');

  return {
    reference_id: params.referenceId,
    consumer_urn: consumerUrn,
    amount: params.amount,
    purpose_message: params.purposeMessage,
    generate_uri: true,
    expiry_time: 1440, // minutes; API maximum is 1440 (24h)
  };
}

function parseDecentroResponse(data: Record<string, unknown>) {
  const inner = (data?.data ?? {}) as Record<string, unknown>;
  const upiUris = (inner?.upi_uris ?? {}) as Record<string, unknown>;
  return {
    ok: data?.api_status === 'SUCCESS',
    transactionId: (data?.decentro_txn_id ?? null) as string | null,
    paymentLink: (upiUris?.common_uri ?? null) as string | null,
    transactionStatus: (inner?.transaction_status ?? null) as string | null,
  };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  try {
    const authHeader = request.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Missing authorization token.' }, 401);
    }

    const supabaseUrl = getRequiredEnv('SUPABASE_URL');
    const serviceRoleKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = getRequiredEnv('SUPABASE_ANON_KEY');

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return jsonResponse({ error: 'Unauthorized.' }, 401);

    const body = await request.json().catch(() => ({}));
    const chargeId = typeof body.charge_id === 'string' ? body.charge_id : null;
    if (!chargeId) return jsonResponse({ error: 'charge_id is required.' }, 400);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // The tenant must own the charge.
    const { data: tenant } = await adminClient
      .from('tenants')
      .select('id, full_name')
      .eq('profile_id', user.id)
      .eq('is_active', true)
      .maybeSingle();
    if (!tenant) return jsonResponse({ error: 'No active tenant for this login.' }, 403);

    const { data: charge } = await adminClient
      .from('charges')
      .select('id, tenant_id, room_id, charge_type, amount, amount_paid, late_fee, status, due_date')
      .eq('id', chargeId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (!charge) return jsonResponse({ error: 'Charge not found.' }, 404);
    if (charge.status === 'paid' || charge.status === 'cancelled') {
      return jsonResponse({ error: 'Charge is already settled.' }, 409);
    }

    const lateFee = Math.max(Number(charge.late_fee || 0), 0);
    const outstanding = Math.max(
      Number(charge.amount || 0) + lateFee - Number(charge.amount_paid || 0),
      0
    );
    if (outstanding <= 0) return jsonResponse({ error: 'Nothing outstanding.' }, 409);

    // Reuse an unexpired link for this charge if one exists.
    const { data: existing } = await adminClient
      .from('charge_payments')
      .select('id, payment_url, metadata, created_at')
      .eq('charge_id', charge.id)
      .eq('provider', 'decentro')
      .eq('status', 'created')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing?.payment_url) {
      const ageMs = Date.now() - new Date(existing.created_at).getTime();
      const linkAmount = Number(
        (existing.metadata as Record<string, unknown>)?.amount ?? NaN
      );
      // Reuse only when the amount still matches (partial payments change it).
      if (ageMs < 3 * 24 * 60 * 60 * 1000 && linkAmount === outstanding) {
        return jsonResponse({
          ok: true,
          reused: true,
          payment_id: existing.id,
          payment_url: existing.payment_url,
          amount: outstanding,
        });
      }
    }

    const { data: room } = await adminClient
      .from('rooms')
      .select('room_number')
      .eq('id', charge.room_id)
      .maybeSingle();

    const referenceId = createReferenceId(charge.id);
    const roomLabel = (room?.room_number ?? 'Room').trim();
    // Alphanumeric-only: UPI note fields reject special characters in some apps.
    const purposeMessage = `${roomLabel} ${charge.charge_type}`
      .replace(/[^A-Za-z0-9 ]/g, '')
      .slice(0, 30);

    const baseUrl = getRequiredEnv('DECENTRO_BASE_URL'); // staging vs production
    const decentroResponse = await fetch(`${baseUrl}/v3/payments/upi/link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // MUST be present — Decentro's nginx 403s requests with no User-Agent.
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        client_id: getRequiredEnv('DECENTRO_CLIENT_ID'),
        client_secret: getRequiredEnv('DECENTRO_CLIENT_SECRET'),
      },
      body: JSON.stringify(
        buildDecentroRequest({ referenceId, amount: outstanding, purposeMessage })
      ),
    });

    const rawBody = await decentroResponse.text();
    let decentroData: Record<string, unknown> = {};
    try {
      decentroData = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      decentroData = {};
    }

    if (!decentroResponse.ok) {
      return jsonResponse(
        {
          error: 'Decentro link creation failed.',
          details:
            (decentroData?.message as string | undefined) ??
            (decentroData?.response_message as string | undefined) ??
            `HTTP ${decentroResponse.status}: ${rawBody.slice(0, 200)}`,
        },
        502
      );
    }

    const parsed = parseDecentroResponse(decentroData);
    if (!parsed.ok || !parsed.paymentLink) {
      return jsonResponse(
        { error: 'Decentro response had no payment link.', details: decentroData },
        502
      );
    }

    const { data: paymentRow, error: insertError } = await adminClient
      .from('charge_payments')
      .insert({
        charge_id: charge.id,
        tenant_id: charge.tenant_id,
        amount: outstanding,
        status: 'created',
        provider: 'decentro',
        method: 'upi',
        payment_url: parsed.paymentLink,
        reference_number: referenceId,
        metadata: {
          amount: outstanding,
          decentro_txn_id: parsed.transactionId,
          transaction_status: parsed.transactionStatus,
          purpose_message: purposeMessage,
          decentro_response: decentroData,
        },
      })
      .select('id')
      .single();

    if (insertError) {
      return jsonResponse(
        { error: `Link created but payment row failed: ${insertError.message}` },
        500
      );
    }

    return jsonResponse({
      ok: true,
      reused: false,
      payment_id: paymentRow.id,
      payment_url: parsed.paymentLink,
      transaction_status: parsed.transactionStatus,
      amount: outstanding,
      reference_id: referenceId,
    });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : 'Unknown error.' },
      500
    );
  }
});
