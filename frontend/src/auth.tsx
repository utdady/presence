import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  clearToken,
  fetchMe,
  getToken,
  login as apiLogin,
  setToken,
  signup as apiSignup,
} from './api'
import {
  deriveAndStoreIdentityKeypair,
  getOrCreateIdentityKeypair,
  initCrypto,
} from './crypto'
import type { UserPublic } from './types'

interface AuthState {
  user: UserPublic | null
  token: string | null
  publicKey: string | null
  privateKey: string | null
  ready: boolean
  login: (username: string, password: string) => Promise<void>
  signup: (input: {
    invite_code: string
    username: string
    display_name: string
    password: string
  }) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserPublic | null>(null)
  const [token, setTokenState] = useState<string | null>(null)
  const [publicKey, setPublicKey] = useState<string | null>(null)
  const [privateKey, setPrivateKey] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await initCrypto()
      // Session restore: use last derived/stored identity (no password on hand).
      const keys = await getOrCreateIdentityKeypair()
      if (cancelled) return
      setPublicKey(keys.publicKey)
      setPrivateKey(keys.privateKey)

      const existing = getToken()
      if (existing) {
        try {
          const me = await fetchMe(existing)
          if (!cancelled) {
            setTokenState(existing)
            setUser(me)
          }
        } catch {
          clearToken()
        }
      }
      if (!cancelled) setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const res = await apiLogin(username, password)
    const keys = await deriveAndStoreIdentityKeypair(username, password)
    setPublicKey(keys.publicKey)
    setPrivateKey(keys.privateKey)
    setToken(res.access_token)
    setTokenState(res.access_token)
    setUser(res.user)
  }, [])

  const signup = useCallback(
    async (input: {
      invite_code: string
      username: string
      display_name: string
      password: string
    }) => {
      const res = await apiSignup(input)
      const keys = await deriveAndStoreIdentityKeypair(
        input.username,
        input.password,
      )
      setPublicKey(keys.publicKey)
      setPrivateKey(keys.privateKey)
      setToken(res.access_token)
      setTokenState(res.access_token)
      setUser(res.user)
      const url = new URL(window.location.href)
      url.searchParams.delete('invite')
      window.history.replaceState({}, '', url.pathname + url.search)
    },
    [],
  )

  const logout = useCallback(() => {
    clearToken()
    setTokenState(null)
    setUser(null)
  }, [])

  const value = useMemo(
    () => ({
      user,
      token,
      publicKey,
      privateKey,
      ready,
      login,
      signup,
      logout,
    }),
    [user, token, publicKey, privateKey, ready, login, signup, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}
