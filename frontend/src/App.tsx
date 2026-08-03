import { useMemo, useState } from 'react'
import { AuthProvider, useAuth } from './auth'
import { BrandMark } from './components/BrandMark'
import { LoginPage } from './pages/LoginPage'
import { SignupPage } from './pages/SignupPage'
import { AppShell } from './pages/AppShell'
import { ThemeProvider } from './theme'
import './index.css'

function Root() {
  const { user, ready } = useAuth()
  const inviteFromUrl = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('invite')?.trim() ?? ''
  }, [])
  const [authView, setAuthView] = useState<'login' | 'signup'>(
    inviteFromUrl ? 'signup' : 'login',
  )

  if (!ready) {
    return (
      <div className="login-page">
        <BrandMark size={36} />
      </div>
    )
  }

  if (user) return <AppShell />

  if (authView === 'signup') {
    return (
      <SignupPage
        initialInvite={inviteFromUrl}
        onBack={() => setAuthView('login')}
      />
    )
  }

  return <LoginPage onJoin={() => setAuthView('signup')} />
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Root />
      </AuthProvider>
    </ThemeProvider>
  )
}