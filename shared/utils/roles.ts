// Who's who in an org (docs/spec.md §3): the owner (pays), the team (plans and runs the account)
// and the cast (on camera, free).

export type OrgRole = 'owner' | 'team' | 'cast'

/** The owner and the team: everyone who can plan and run the account. */
export const isTeamRole = (role: string | null | undefined) => role === 'owner' || role === 'team'

export const ROLE_LABELS: Record<OrgRole, string> = { owner: 'Owner', team: 'Team', cast: 'Cast' }

export const roleLabel = (role: string | null | undefined) => ROLE_LABELS[role as OrgRole] ?? 'Cast'
