// Org gate. @nuxtjs/supabase already sends signed-out visitors to /login; this signs out anyone
// who isn't in an org (they need an invite), unless they can start one, and asks someone in several
// orgs which one they're working in. Cast see their shoots and chat; the rest is the team's.
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/login' || to.path === '/confirm' || to.path === '/reset-password') return

  const user = useSupabaseUser()
  if (!user.value) return

  const { ensure, isAdmin, isCast, reset } = useAccess()
  const { needsPicker, signupOpen } = useOrg()
  if (!(await ensure(user.value))) {
    if (await signupOpen()) return to.path === '/onboarding' ? undefined : navigateTo('/onboarding')
    reset()
    await useSupabaseClient().auth.signOut({ scope: 'local' })
    return navigateTo('/login?denied=1')
  }

  // connecting Klip picks its own org, and works whatever the subscription (the license says)
  // connecting an AI app picks its own org too
  if (to.path === '/klip/activate' || to.path === '/oauth/consent') return
  // Your account is theirs, whatever the organisation's state; it's also where they pick one
  if (to.path === '/account') return
  if (needsPicker.value) return navigateTo('/account')
  // the Library and Brands are the team's: cast land on their shoots
  if (isCast.value && (to.path === '/' || to.path.startsWith('/library') || to.path.startsWith('/brands'))) return navigateTo('/shoots')
  // Settings is the organisation's, for the team; everyone's own things are in Your account
  if (to.path.startsWith('/settings') && !isAdmin.value) return navigateTo('/account')
  // Connect your AI moved from Settings to Your account
  if (to.path.startsWith('/settings') && to.query.tab === 'ai') return navigateTo('/account?tab=ai')
})
