export type VcPackage = {
  id: number;
  vc: number;
  /** Canonical Robokassa amount in RUB. Never convert this for payment. */
  price: number;
  bonus?: string;
  label: string;
};

export const VC_PACKAGES: VcPackage[] = [
  { id: 1, vc: 1000, price: 300, label: "1000 VC" },
  { id: 2, vc: 2500, price: 600, bonus: "+20%", label: "2500 VC" },
  { id: 3, vc: 7000, price: 1500, bonus: "+40%", label: "7000 VC" },
  { id: 4, vc: 16000, price: 3000, bonus: "+60%", label: "16000 VC" },
  { id: 5, vc: 35000, price: 6000, bonus: "+80%", label: "35000 VC" },
  { id: 6, vc: 100000, price: 15000, bonus: "+100%", label: "100000 VC" },
];

export function getVcPackage(id: number): VcPackage | undefined {
  return VC_PACKAGES.find((pkg) => pkg.id === id);
}
