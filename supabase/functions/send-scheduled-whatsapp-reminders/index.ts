import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type ChargeRow = {
  id: string;
  tenant_id: string;
  room_id: string;
  group_id: string;
  charge_type: string;
  amount: number | string;
  amount_paid: number | string;
  late_fee: number | string | null;
  status: string;
  due_date: string;
  period_start: string;
  period_end: string;
};

type TenantRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  is_active: boolean;
};

type RoomRow = {
  id: string;
  room_number: string | null;
};

type ReminderType =
  | 'due_tomorrow'
  | 'due_today'
  | 'overdue_3_days'
  | 'overdue_7_days'
  | 'overdue_daily';

// v2 is the post-Razorpay template: Utility, English, NO buttons, 6 body params.
//   Hi {{1}}, this is a payment reminder for {{2}}.
//   Your {{3}} payment of ₹{{4}} is due on {{5}}.
//   To pay, open the DaboRent app or send the amount by UPI to {{6}}.
const templateName = Deno.env.get('WHATSAPP_TEMPLATE_NAME') ??
  'tenant_payment_due_v2';
const templateLanguageCode = Deno.env.get('WHATSAPP_TEMPLATE_LANG') ?? 'en';

// Payee UPI address shown to tenants as {{6}}.
const upiVpa = Deno.env.get('UPI_VPA') ?? 'cordeliabbarreto-1@oksbi';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

function getRequiredEnv(name: string) {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error(`${name} is not configured.`);
  }

  return value;
}

function formatCurrencyValue(value: number | string) {
  return Number(value || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatChargeType(type: string) {
  if (type === 'rent') return 'Rent';
  if (type === 'water') return 'Water';
  if (type === 'electricity') return 'Electricity';

  return type.replace(/_/g, ' ').replace(/\b\w/g, (letter) =>
    letter.toUpperCase()
  );
}

// Matches the sample submitted with the template: 09/08/2026
function formatDateDDMMYYYY(value: string) {
  const [year, month, day] = value.split('-');

  if (!year || !month || !day) {
    return value;
  }

  return `${day}/${month}/${year}`;
}

// room_number already carries its own prefix in this database ("Room 7",
// "ROOM 11"), and {{2}} is the full room text, so it is passed through as-is.
function formatRoomLabel(room: RoomRow | null) {
  const roomNumber = room?.room_number?.trim();

  return roomNumber && roomNumber.length > 0 ? roomNumber : 'your room';
}

function normalizeWhatsAppPhone(value?: string | null) {
  const digits = String(value ?? '').replace(/\D/g, '');

  if (!digits) {
    return '';
  }

  if (digits.startsWith('00')) {
    return digits.slice(2);
  }

  if (digits.length === 10) {
    return `91${digits}`;
  }

  return digits;
}

function getIndiaDateParts(offsetDays: number) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = formatter.formatToParts(new Date());
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const year = Number(parts.find((part) => part.type === 'year')?.value);

  const date = new Date(Date.UTC(year, month - 1, day + offsetDays));

  return date.toISOString().slice(0, 10);
}

function getTargetDate(reminderType: ReminderType) {
  if (reminderType === 'due_today') {
    return getIndiaDateParts(0);
  }

  if (reminderType === 'overdue_3_days') {
    return getIndiaDateParts(-3);
  }

  if (reminderType === 'overdue_7_days') {
    return getIndiaDateParts(-7);
  }

  return getIndiaDateParts(1);
}

async function getTenant(
  adminClient: ReturnType<typeof createClient>,
  tenantId: string
) {
  const { data, error } = await adminClient
    .from('tenants')
    .select('id, full_name, email, phone, is_active')
    .eq('id', tenantId)
    .maybeSingle();

  if (error) {
    throw new Error(`Tenant lookup failed: ${error.message}`);
  }

  return data as TenantRow | null;
}

async function getRoom(
  adminClient: ReturnType<typeof createClient>,
  roomId: string
) {
  const { data } = await adminClient
    .from('rooms')
    .select('id, room_number')
    .eq('id', roomId)
    .maybeSingle();

  return data as RoomRow | null;
}

function buildTemplateParameters(params: {
  tenant: TenantRow;
  room: RoomRow | null;
  charge: ChargeRow;
  outstanding: number;
}) {
  return [
    params.tenant.full_name ?? 'Tenant',
    formatRoomLabel(params.room),
    formatChargeType(params.charge.charge_type),
    formatCurrencyValue(params.outstanding),
    formatDateDDMMYYYY(params.charge.due_date),
    upiVpa,
  ];
}

function buildPreviewMessage(bodyParameters: string[]) {
  const [name, room, chargeType, amount, dueDate, vpa] = bodyParameters;

  return [
    `Hi ${name}, this is a payment reminder for ${room}.`,
    `Your ${chargeType} payment of ₹${amount} is due on ${dueDate}.`,
    `To pay, open the DaboRent app or send the amount by UPI to ${vpa}.`,
  ].join('\n');
}

function buildMetaPayload(to: string, bodyParameters: string[]) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: {
        code: templateLanguageCode,
      },
      components: [
        {
          type: 'body',
          parameters: bodyParameters.map((text) => ({
            type: 'text',
            text,
          })),
        },
      ],
    },
  };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405);
  }

  try {
    const cronSecret = getRequiredEnv('WHATSAPP_CRON_SECRET');
    const requestSecret = request.headers.get('x-cron-secret') ?? '';

    if (!requestSecret || requestSecret !== cronSecret) {
      return jsonResponse({ error: 'Unauthorized.' }, 401);
    }

    const body = await request.json().catch(() => ({}));

    const reminderType = (body.reminder_type ??
      'due_tomorrow') as ReminderType;

    const allowedReminderTypes: ReminderType[] = [
      'due_tomorrow',
      'due_today',
      'overdue_3_days',
      'overdue_7_days',
      'overdue_daily',
    ];

    if (!allowedReminderTypes.includes(reminderType)) {
      return jsonResponse({ error: 'Invalid reminder_type.' }, 400);
    }

    // dry_run builds and returns exactly what would be sent, but contacts
    // nobody and writes no log rows -- so it never blocks the real send.
    const dryRun = body.dry_run === true;

    const isOverdueDaily = reminderType === 'overdue_daily';
    const todayIst = getIndiaDateParts(0);

    const targetDate = isOverdueDaily
      ? todayIst
      : typeof body.target_date === 'string'
      ? body.target_date
      : getTargetDate(reminderType);

    const dedupReminderType: string = isOverdueDaily
      ? `overdue_daily_${todayIst}`
      : reminderType;

    const limit =
      typeof body.limit === 'number' && body.limit > 0
        ? Math.min(body.limit, 100)
        : 100;

    const supabaseUrl = getRequiredEnv('SUPABASE_URL');
    const serviceRoleKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');
    const whatsappAccessToken = getRequiredEnv('WHATSAPP_ACCESS_TOKEN');
    const whatsappPhoneNumberId = getRequiredEnv('WHATSAPP_PHONE_NUMBER_ID');

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    let chargesQuery = adminClient
      .from('charges')
      .select(
        `
        id,
        tenant_id,
        room_id,
        group_id,
        charge_type,
        amount,
        amount_paid,
        late_fee,
        status,
        due_date,
        period_start,
        period_end
      `
      )
      .not('status', 'in', '(paid,cancelled)')
      .order('due_date', { ascending: true })
      .limit(limit);

    chargesQuery = isOverdueDaily
      ? chargesQuery.lt('due_date', todayIst)
      : chargesQuery.eq('due_date', targetDate);

    const { data: chargeData, error: chargeError } = await chargesQuery;

    if (chargeError) {
      return jsonResponse(
        { error: 'Charge lookup failed.', details: chargeError.message },
        500
      );
    }

    const charges = (chargeData ?? []) as ChargeRow[];

    const results: Record<string, unknown>[] = [];

    for (const charge of charges) {
      // Every charge is isolated: one tenant blowing up must never stop the
      // rest of the run. This is what made the Razorpay outage total.
      try {
        const amount = Number(charge.amount || 0);
        const amountPaid = Number(charge.amount_paid || 0);
        const lateFee = Math.max(Number(charge.late_fee || 0), 0);
        const outstanding = Math.max(amount + lateFee - amountPaid, 0);

        if (outstanding <= 0) {
          results.push({
            charge_id: charge.id,
            status: 'skipped',
            reason: 'No outstanding amount.',
          });
          continue;
        }

        // Dedup is keyed on charge + reminder type only. It deliberately does
        // NOT filter on template_name, so the v1 -> v2 switch cannot cause a
        // tenant to be reminded twice for the same charge on the same day.
        const { data: existingLog } = await adminClient
          .from('whatsapp_message_logs')
          .select('id, status')
          .eq('charge_id', charge.id)
          .eq('reminder_type', dedupReminderType)
          .in('status', ['dry_run', 'queued', 'sent', 'delivered', 'read'])
          .limit(1)
          .maybeSingle();

        if (existingLog) {
          results.push({
            charge_id: charge.id,
            status: 'skipped',
            reason: `Reminder already exists with status ${existingLog.status}.`,
            log_id: existingLog.id,
          });
          continue;
        }

        const tenant = await getTenant(adminClient, charge.tenant_id);
        const room = await getRoom(adminClient, charge.room_id);

        if (!tenant) {
          results.push({
            charge_id: charge.id,
            status: 'skipped',
            reason: 'Tenant not found.',
          });
          continue;
        }

        if (!tenant.is_active) {
          results.push({
            charge_id: charge.id,
            status: 'skipped',
            reason: 'Tenant is inactive or checked out.',
          });
          continue;
        }

        const whatsappTo = normalizeWhatsAppPhone(tenant.phone);

        if (!whatsappTo) {
          if (!dryRun) {
            await adminClient.from('whatsapp_message_logs').insert({
              charge_id: charge.id,
              tenant_id: charge.tenant_id,
              tenant_phone: tenant.phone ?? null,
              template_name: templateName,
              reminder_type: dedupReminderType,
              charge_type: charge.charge_type,
              due_date: charge.due_date,
              payment_url: null,
              status: 'skipped',
              error_message: 'Tenant has no valid WhatsApp phone number.',
              payload: { target_date: targetDate },
            });
          }

          results.push({
            charge_id: charge.id,
            status: 'skipped',
            reason: 'Tenant has no valid WhatsApp phone number.',
          });
          continue;
        }

        const bodyParameters = buildTemplateParameters({
          tenant,
          room,
          charge,
          outstanding,
        });
        const previewMessage = buildPreviewMessage(bodyParameters);
        const metaPayload = buildMetaPayload(whatsappTo, bodyParameters);

        if (dryRun) {
          results.push({
            charge_id: charge.id,
            status: 'dry_run',
            reminder_type: reminderType,
            whatsapp_to: whatsappTo,
            template_name: templateName,
            outstanding,
            body_parameters: bodyParameters,
            preview_message: previewMessage,
          });
          continue;
        }

        const { data: logRow, error: logError } = await adminClient
          .from('whatsapp_message_logs')
          .insert({
            charge_id: charge.id,
            tenant_id: charge.tenant_id,
            tenant_phone: whatsappTo,
            template_name: templateName,
            reminder_type: dedupReminderType,
            charge_type: charge.charge_type,
            due_date: charge.due_date,
            payment_url: null,
            status: 'queued',
            payload: {
              target_date: targetDate,
              base_reminder_type: reminderType,
              outstanding,
              upi_vpa: upiVpa,
              body_parameters: bodyParameters,
              preview_message: previewMessage,
            },
          })
          .select('id')
          .single();

        if (logError) {
          results.push({
            charge_id: charge.id,
            status: 'failed',
            reason: `Log insert failed: ${logError.message}`,
          });
          continue;
        }

        let sendStatus: 'sent' | 'failed' = 'failed';
        let providerMessageId: string | null = null;
        let sendError: string | null = null;

        try {
          const metaResponse = await fetch(
            `https://graph.facebook.com/v25.0/${whatsappPhoneNumberId}/messages`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${whatsappAccessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(metaPayload),
            }
          );

          const metaResult = await metaResponse.json().catch(() => ({}));

          if (metaResponse.ok) {
            sendStatus = 'sent';
            providerMessageId =
              (metaResult as Record<string, { id?: string }[]>)?.messages?.[0]
                ?.id ?? null;
          } else {
            sendError =
              (metaResult as Record<string, { message?: string }>)?.error
                ?.message ?? `HTTP ${metaResponse.status}`;
          }
        } catch (err) {
          sendError = err instanceof Error ? err.message : 'Network error';
        }

        await adminClient
          .from('whatsapp_message_logs')
          .update({
            status: sendStatus,
            provider_message_id: providerMessageId,
            error_message: sendError,
            sent_at: sendStatus === 'sent' ? new Date().toISOString() : null,
          })
          .eq('id', logRow.id);

        results.push({
          charge_id: charge.id,
          log_id: logRow.id,
          status: sendStatus,
          reminder_type: reminderType,
          whatsapp_to: whatsappTo,
          template_name: templateName,
          ...(sendError ? { error: sendError } : {}),
        });
      } catch (err) {
        results.push({
          charge_id: charge.id,
          status: 'failed',
          reason: err instanceof Error ? err.message : 'Unknown charge error.',
        });
      }
    }

    const sent = results.filter((r) => r.status === 'sent').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    const dryRunCount = results.filter((r) => r.status === 'dry_run').length;

    return jsonResponse({
      ok: true,
      dry_run: dryRun,
      reminder_type: reminderType,
      target_date: targetDate,
      template_name: templateName,
      upi_vpa: upiVpa,
      total_charges_checked: charges.length,
      sent,
      failed,
      skipped,
      ...(dryRun ? { dry_run_count: dryRunCount } : {}),
      results,
    });
  } catch (error) {
    return jsonResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unknown scheduled WhatsApp reminder error.',
      },
      500
    );
  }
});
