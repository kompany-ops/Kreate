export interface MyOrg {
  id: string
  name: string
  slug: string
  role: string
  display_name: string | null
  is_current: boolean
  has_chosen: boolean
  /** always true now that Free is a plan (kept for the license and the AI connector) */
  entitled: boolean
  /** how it has Klip: bought, billing-exempt, included in Studio, a brand's seat, for the length of its trial, or not at all */
  klip_access: 'purchased' | 'exempt' | 'included' | 'seat' | 'trial' | 'none'
  /** its photo, set by its team (Settings → Profile) */
  logo_url: string | null
  /** creator (shoots), brand (one brand: its profile and library) or agency */
  kind: 'creator' | 'brand' | 'agency'
  /** a guest: the shoots they're on (they see nothing else of the account); null for everyone else */
  shoot_ids: string[] | null
}

/**
 * The signed-in user's orgs (spec §3). The owner pays and the team invites people; everything a
 * request reads or writes belongs to its current org, which the database works out, so queries
 * don't filter on it. Someone in several orgs picks one, and switching reloads the app so nothing
 * from the last org lingers on screen.
 */
export const useOrg = () => {
  const db = useDb()
  const orgs = useState<MyOrg[]>('orgs', () => [])
  const currentOrg = computed(() => orgs.value.find(org => org.is_current) ?? null)
  /** in several orgs and hasn't chosen one yet */
  const needsPicker = computed(() => orgs.value.length > 1 && !orgs.value.some(org => org.has_chosen))

  async function load() {
    const { data, error } = await db.rpc('my_orgs')
    if (error) throw error
    orgs.value = (data ?? []) as MyOrg[]
    return orgs.value
  }

  async function enter(path = '/library') {
    // a new access token carries the new org, once the token hook is on
    await db.auth.refreshSession()
    window.location.assign(path)
  }

  async function switchOrg(id: string) {
    const { error } = await db.rpc('set_active_org', { p_org_id: id })
    if (error) throw error
    await enter()
  }

  /** Start an account of a kind; its profile (who it is and how its scripts sound) is saved with it. */
  async function createOrg(name: string, slug: string, profile?: OrgProfile, kind: 'creator' | 'brand' | 'agency' = 'creator') {
    const { error } = await db.rpc('create_org', { p_name: name, p_slug: slug, p_profile: profile ? { ...profile } : {}, p_kind: kind })
    if (error) throw error
    // a creator starts on Free in the Library; a brand on its Brand page; an agency on its brands
    await enter(kind === 'brand' ? '/brand' : kind === 'agency' ? '/brands' : '/library')
  }

  /** whether someone can start a new org (open: everyone starts on Free) */
  async function signupOpen() {
    const { data } = await db.rpc('org_signup_open')
    return !!data
  }

  return { orgs, currentOrg, needsPicker, load, switchOrg, createOrg, signupOpen }
}
