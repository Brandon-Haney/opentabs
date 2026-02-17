import type { TrustTier } from '@opentabs-dev/shared';

const TrustBadge = ({ tier }: { tier: TrustTier }) => {
  const tierStyles: Record<TrustTier, string> = {
    official: 'bg-blue-900/50 text-blue-300 border-blue-700/50',
    community: 'bg-purple-900/50 text-purple-300 border-purple-700/50',
    local: 'bg-gray-800/50 text-gray-400 border-gray-700/50',
  };
  const tierClass = tierStyles[tier];

  const label = tier.charAt(0).toUpperCase() + tier.slice(1);

  return <span className={`rounded border px-1.5 py-0.5 text-[10px] ${tierClass}`}>{label}</span>;
};

export { TrustBadge };
