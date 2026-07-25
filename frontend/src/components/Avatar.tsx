import type { UserPublic } from '../types'
import { avatarDataUrl } from '../avatarImage'

export function Avatar({
  user,
  size = 40,
  dimmed = false,
  imageB64,
}: {
  user: Pick<UserPublic, 'display_name' | 'avatar_color'>
  size?: number
  dimmed?: boolean
  imageB64?: string | null
}) {
  const initials = user.display_name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return (
    <div
      className={`avatar${dimmed ? ' avatar--dim' : ''}`}
      style={{
        width: size,
        height: size,
        backgroundColor: user.avatar_color,
        fontSize: size * 0.36,
      }}
      aria-hidden
    >
      {imageB64 ? (
        <img
          className="avatar-img"
          src={avatarDataUrl(imageB64)}
          alt=""
          width={size}
          height={size}
        />
      ) : (
        initials
      )}
    </div>
  )
}
