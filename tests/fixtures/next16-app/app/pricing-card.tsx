"use client";

import { useState } from "react";

export default function PricingCard() {
  const [count, setCount] = useState(0);
  return (
    <div data-testid="pricing-Pro" className="card">
      <h2>Pro plan</h2>
      <p>Clicked {count} times</p>
      <button onClick={() => setCount((c) => c + 1)}>Upgrade</button>
    </div>
  );
}
