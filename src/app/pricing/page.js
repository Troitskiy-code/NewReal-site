"use client";

import Footer from "@/components/Footer";
import SubscriptionPlans from "@/components/SubscriptionPlans";

export default function PricingPage() {
  return (
    <div className="flex min-h-dvh flex-col overflow-hidden bg-wd-bg text-wd-text">
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col items-center gap-10 overflow-y-auto px-4 py-12 scrollbar-subtle sm:px-6 lg:px-8">
        <SubscriptionPlans />
      </main>

      <Footer />
    </div>
  );
}
