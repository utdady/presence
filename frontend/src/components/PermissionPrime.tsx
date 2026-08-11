import { FEATURE_PRIME, type FeatureKind } from '../featurePermissions'
import { hapticLight, hapticMedium } from '../haptics'

export function PermissionPrime({
  feature,
  onContinue,
  onNotNow,
}: {
  feature: FeatureKind
  onContinue: () => void
  onNotNow: () => void
}) {
  const copy = FEATURE_PRIME[feature]
  return (
    <div className="perm-prime" role="dialog" aria-modal="true" aria-labelledby="perm-prime-title">
      <div className="perm-prime-sheet">
        <h2 id="perm-prime-title">{copy.title}</h2>
        <p>{copy.body}</p>
        <div className="perm-prime-actions">
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              hapticLight()
              onNotNow()
            }}
          >
            {copy.denyLabel}
          </button>
          <button
            type="button"
            onClick={() => {
              hapticMedium()
              onContinue()
            }}
          >
            {copy.allowLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
