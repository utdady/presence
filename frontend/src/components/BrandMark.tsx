/** Presence wordmark + mark used on login and shell headers. */
export function BrandMark({
  size = 28,
  showWord = true,
}: {
  size?: number
  showWord?: boolean
}) {
  return (
    <span className="brand-mark">
      <img
        className="brand-mark-icon"
        src="/favicon.svg"
        alt=""
        width={size}
        height={size}
      />
      {showWord && <span className="brand">Presence</span>}
    </span>
  )
}
