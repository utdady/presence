import { AuthProvider, useAuth } from './auth'
import { LoginPage } from './pages/LoginPage'
import { AppShell } from './pages/AppShell'
import { ThemeProvider } from './theme'
import './index.css'

function Root() {
  const { user, ready } = useAuth()

  if (!ready) {
    return (
      <div className="login-page">
        <p className="brand">Presence</p>
      </div>
    )
  }

  return user ? <AppShell /> : <LoginPage />
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