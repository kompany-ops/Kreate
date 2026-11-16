import type { PlanId } from '#shared/utils/plans'

export interface MyPlan {
  plan: PlanId
  billing_exempt: boolean
  extra_team: number
  team_used: number
  /** null: unlimited */
  team_limit: number | null
  cast_used: number
  cast_limit: number | null
  channels_used: number
  channels_limit: number | null
  brands_used: number
  brands_limit: number | null
  shoots_used: number
  shoots_limit: number | null
}

/**
 * The current org's plan, what it includes and what it's using (docs/spec.md §2): from
 * public.my_plan, which counts the same way the database's limits do.
 */
export const usePlan = () => {
  const db = useDb()
  const plan = useState<MyPlan | null>('my-plan', () => null)

  async function loadPlan() {
    const { data, error } = await db.rpc('my_plan')
    if (error) throw error
    plan.value = (data?.[0] ?? null) as MyPlan | null
    return plan.value
  }

  /** the team is full, but the owner can buy another place */
  const teamFull = computed(() => !!plan.value && plan.value.team_limit !== null && plan.value.team_used >= plan.value.team_limit)

  /** Buy one more team place ($29.99 a month), after asking. True once it's bought. */
  async function buyTeamPlace() {
    const current = plan.value
    if (!current || current.plan === 'free' || current.billing_exempt) return false
    const { confirmDialog } = useConfirm()
    if (!(await confirmDialog({
      title: 'Add a team place?',
      description: `${PLANS[current.plan].title} includes ${PLANS[current.plan].limits.team} team ${PLANS[current.plan].limits.team === 1 ? 'member' : 'members'}${current.extra_team ? ` and you have ${current.extra_team} extra` : ''}. Another place is $${TEAM_MEMBER.price} a month, charged pro rata from today.`,
      confirmLabel: `Add for $${TEAM_MEMBER.price}/mo`
    }))) return false
    try {
      await $fetch('/api/billing/team-seats', { method: 'POST', body: { extra: current.extra_team + 1 } })
      await loadPlan()
      return true
    } catch (error) {
      useToast().add({ title: 'Couldn\'t add the team place', description: (error as { data?: { statusMessage?: string } }).data?.statusMessage ?? (error as Error).message, color: 'error' })
      return false
    }
  }

  return { plan, teamFull, loadPlan, buyTeamPlace }
}
