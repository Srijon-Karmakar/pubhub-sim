import { useState } from 'react';
import { Globe } from 'lucide-react';

/** Country flag as an image (Windows has no flag emoji). */
export function Flag({ cc }: { cc?: string }) {
  const [broken, setBroken] = useState(false);
  if (!cc || cc.length !== 2 || broken) return <Globe size={18} style={{ opacity: 0.6, flex: 'none' }} />;
  return <img className="flag-img" src={`https://flagcdn.com/${cc.toLowerCase()}.svg`} alt={cc} loading="lazy" onError={() => setBroken(true)} />;
}
