import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// v2 is the post-Razorpay template: Utility, English, NO buttons, 6 body params.
// v1 had a mandatory URL button hardcoded to https://rzp.io/rzp/, which is dead.
const templateName = Deno.env.get('WHATSAPP_TEMPLATE_NAME') ?? 'tenant_payment_due_v2';
// IMPORTANT: must match the language code under which the template was approved
// in Meta Business Manager. Our template is approved under 'English' = code 'en'.
// Using 'en_US' caused Meta to return (#132001) 'Template name does not exist in the translation'.
const templateLanguageCode = Deno.env.get('WHATSAPP_TEMPLATE_LANG') ?? 'en';

// Payee UPI address shown to tenants as {{6}}.
const upiVpa = Deno.env.get('UPI_VPA') ?? 'cordeliabbarreto-1@oksbi';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
function getRequiredEnv(name) { const v = Deno.env.get(name); if (!v) throw new Error(`${name} is not configured.`); return v; }
function normalizeWhatsAppPhone(value) { const digits = String(value ?? '').replace(/\D/g, ''); if (!digits) return ''; if (digits.startsWith('00')) return digits.slice(2); if (digits.length === 10) return `91${digits}`; return digits; }
function formatCurrencyValue(value) { return Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function formatChargeType(type) { if (type === 'rent') return 'Rent'; if (type === 'water') return 'Water'; if (type === 'electricity') return 'Electricity'; return type.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()); }
// Matches the sample submitted with the template: 09/08/2026
function formatDateDDMMYYYY(value) { const [year, month, day] = value.split('-'); if (!year || !month || !day) return value; return `${day}/${month}/${year}`; }
// room_number already carries its own prefix in this database ("Room 7", "ROOM 11"),
// and {{2}} is the full room text, so it is passed through as-is.
function formatRoomLabel(roomNumber) { const n = String(roomNumber ?? '').trim(); return n.length > 0 ? n : 'your room'; }

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  try {
    const authHeader = request.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) return jsonResponse({ error: 'Missing authorization token.' }, 401);

    const supabaseUrl = getRequiredEnv('SUPABASE_URL');
    const serviceRoleKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = getRequiredEnv('SUPABASE_ANON_KEY');

    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return jsonResponse({ error: 'Unauthorized.' }, 401);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: profile } = await adminClient.from('profiles').select('role').eq('id', user.id).maybeSingle();
    const isFullAccess = profile?.role === 'landlord' || profile?.role === 'super_admin';

    if (!isFullAccess) {
      const { data: perm } = await adminClient.from('admin_permissions').select('can_send_reminders').eq('user_id', user.id).maybeSingle();
      if (!perm?.can_send_reminders) return jsonResponse({ error: 'No reminder permission.' }, 403);
    }

    const body = await request.json().catch(() => ({}));
    const chargeId = typeof body.charge_id === 'string' ? body.charge_id : null;
    if (!chargeId) return jsonResponse({ error: 'charge_id is required.' }, 400);

    const { data: charge, error: chargeError } = await adminClient.from('charges').select('id, tenant_id, room_id, group_id, charge_type, amount, amount_paid, late_fee, due_date').eq('id', chargeId).maybeSingle();
    if (chargeError || !charge) return jsonResponse({ error: 'Charge not found.' }, 404);

    const { data: tenant } = await adminClient.from('tenants').select('id, full_name, phone').eq('id', charge.tenant_id).maybeSingle();
    if (!tenant?.phone) return jsonResponse({ error: 'Tenant has no phone number on file. Add one in their profile before sending WhatsApp reminders.' }, 422);

    const toPhone = normalizeWhatsAppPhone(tenant.phone);
    if (!toPhone) return jsonResponse({ error: 'Could not parse tenant phone number.' }, 422);

    const { data: room } = await adminClient.from('rooms').select('room_number').eq('id', charge.room_id).maybeSingle();

    const tenantName = tenant.full_name ?? 'Tenant';
    const roomLabel = formatRoomLabel(room?.room_number);
    const chargeType = formatChargeType(charge.charge_type);
    // Late fee is included so the manual reminder matches the scheduled one.
    const lateFee = Math.max(Number(charge.late_fee || 0), 0);
    const outstanding = Math.max(Number(charge.amount || 0) + lateFee - Number(charge.amount_paid || 0), 0);
    const amount = formatCurrencyValue(outstanding);
    const dueDate = formatDateDDMMYYYY(charge.due_date);

    const bodyParameters = [tenantName, roomLabel, chargeType, amount, dueDate, upiVpa];

    const metaPayload = {
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: templateLanguageCode },
        components: [
          { type: 'body', parameters: bodyParameters.map((text) => ({ type: 'text', text })) },
        ],
      },
    };

    const reminderType = 'manual';
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recentManual } = await adminClient.from('whatsapp_message_logs').select('id, created_at, status').eq('charge_id', chargeId).eq('reminder_type', reminderType).gte('created_at', oneHourAgo).in('status', ['queued', 'sent', 'delivered', 'read']).limit(1);

    if (recentManual && recentManual.length > 0) {
      return jsonResponse({ error: 'A manual WhatsApp reminder was already sent for this charge in the last hour. Try again later.' }, 429);
    }

    const accessToken = getRequiredEnv('WHATSAPP_ACCESS_TOKEN');
    const phoneNumberId = getRequiredEnv('WHATSAPP_PHONE_NUMBER_ID');

    const metaResponse = await fetch(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(metaPayload),
    });

    const metaResult = await metaResponse.json().catch(() => ({}));

    if (!metaResponse.ok) {
      console.error('WhatsApp API error:', JSON.stringify(metaResult));
      const errorDetail = metaResult?.error?.message ?? `HTTP ${metaResponse.status}`;

      await adminClient.from('whatsapp_message_logs').insert({
        charge_id: chargeId, tenant_id: charge.tenant_id, tenant_phone: toPhone,
        template_name: templateName, reminder_type: reminderType, charge_type: charge.charge_type,
        due_date: charge.due_date, payment_url: null,
        provider: 'whatsapp_cloud_api', status: 'failed',
        error_message: typeof errorDetail === 'string' ? errorDetail : JSON.stringify(errorDetail),
        payload: metaPayload,
      });

      return jsonResponse({ error: `WhatsApp delivery failed: ${errorDetail}` }, 502);
    }

    const messageId = metaResult?.messages?.[0]?.id ?? null;

    await adminClient.from('whatsapp_message_logs').insert({
      charge_id: chargeId, tenant_id: charge.tenant_id, tenant_phone: toPhone,
      template_name: templateName, reminder_type: reminderType, charge_type: charge.charge_type,
      due_date: charge.due_date, payment_url: null,
      provider: 'whatsapp_cloud_api', provider_message_id: messageId,
      status: 'sent', sent_at: new Date().toISOString(), payload: metaPayload,
    });

    return jsonResponse({ success: true, message_id: messageId, to: toPhone, tenant_name: tenantName });
  } catch (err) {
    console.error('Unhandled error:', err);
    return jsonResponse({ error: err instanceof Error ? err.message : 'Internal server error.' }, 500);
  }
});
