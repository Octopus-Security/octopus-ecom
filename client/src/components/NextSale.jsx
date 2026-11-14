import React from 'react';

const BUTTON = {
  composer: 'New product',
  product: 'Open the card',
  sales: 'Open sales',
  settings: 'Open settings',
};

/** Read-only. The button only opens a screen. It does not arm dry run, publish, or spend. */
export default function NextSale({ step, onOpen }) {
  if (!step || !step.title) return null;
  const label = BUTTON[step.open] || null;
  const tail = step.dryRun && !/dry run/i.test(step.detail) ? ' Dry run is on. This card does not publish or spend.' : '';
  return (
    <div className="banner next-sale" role="status" data-next-sale={step.code}>
      <p><strong>Next sale. </strong>{step.title}. {step.detail}{tail}</p>
      {label && <button type="button" className="ghost" onClick={() => onOpen(step)}>{label}</button>}
    </div>
  );
}
