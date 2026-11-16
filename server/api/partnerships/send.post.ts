import { serverSupabaseUser } from '#supabase/server'

// Email a partnership invitation (restructure Phase 3): the brand's team sends (or resends) the
// invitation for one of its pending partnerships. From hello@kreate.ugckompany.com, Reply-To the
// sender; its button opens the creator's Brands page, where the invitation waits.
export default defineEventHandler(async (event) => {
  const { db, admin } = await requireMember(event)
  if (!admin) throw createError({ statusCode: 403, statusMessage: 'Only the team can invite creators' })

  const body = await readBody<{ id?: string }>(event)
  const id = String(body?.id ?? '')
  // RLS keeps this to the current account's partnerships
  const { data: partnership } = await db.from('partnerships').select('id, invited_email, brand_name, status, publisher_org_id').eq('id', id).maybeSingle()
  if (!partnership || partnership.status !== 'invited') throw createError({ statusCode: 404, statusMessage: 'There\'s no pending invitation like that' })

  const user = await serverSupabaseUser(event)
  const { data: me } = await db.from('profiles').select('email, display_name, full_name').eq('id', user!.sub).single()
  const inviterName = me?.display_name || me?.full_name || me?.email || partnership.brand_name

  const origin = getRequestURL(event, { xForwardedHost: true, xForwardedProto: true }).origin
  const message = partnerInviteEmail({ brandName: partnership.brand_name, inviterName, email: partnership.invited_email, link: `${origin}/brands` })
  const sent = await sendEmail(event, {
    to: partnership.invited_email,
    ...message,
    replyTo: me?.email ?? undefined,
    // a double click within the same minute sends it once
    idempotencyKey: `partner/${partnership.id}/${Math.floor(Date.now() / 60_000)}`
  })

  const emailedAt = new Date().toISOString()
  await serviceDb(event).from('partnerships').update({ emailed_at: emailedAt }).eq('id', partnership.id)
  return { id: sent.id, emailedAt }
})
