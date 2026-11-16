interface Access {
  /** the signed-in user's id */
  id: string
  email: string
  role: string
  display_name: string | null
  /** what kind of account the current one is */
  kind: 'creator' | 'brand' | 'agency'
}

/**
 * The signed-in user's membership of their current org (spec §3): owner, team or cast. No org means
 * no access, unless they can start one. `isAdmin` means on the team (the owner included): everything
 * that once needed an admin now needs the team.
 */
export const useAccess = () => {
  const { load } = useOrg()
  const access = useState<Access | null>('access', () => null)
  const checkedFor = useState<string | null>('access-checked-for', () => null)

  async function ensure(user: { sub?: string, email?: string } | null | undefined): Promise<boolean> {
    if (!user?.sub) return false
    if (checkedFor.value === user.sub) return !!access.value
    try {
      const current = (await load()).find(org => org.is_current)
      access.value = current
        ? { id: user.sub, email: user.email ?? '', role: current.role, display_name: current.display_name, kind: current.kind ?? 'creator' }
        : null
      checkedFor.value = user.sub
      return !!current
    } catch {
      // A failed lookup (e.g. a network blip on set) is not a denial. RLS still guards the data.
      return true
    }
  }

  function reset() {
    access.value = null
    checkedFor.value = null
  }

  const isAdmin = computed(() => isTeamRole(access.value?.role))
  const isOwner = computed(() => access.value?.role === 'owner')
  const isCast = computed(() => !!access.value && !isTeamRole(access.value.role))
  /** a brand or agency account: it publishes brands and never shoots */
  const isPublisher = computed(() => !!access.value && access.value.kind !== 'creator')

  return { access, isAdmin, isOwner, isCast, isPublisher, ensure, reset }
}
