export type RobokassaClientCheckout = {
  action?: string;
  method?: string;
  fields?: Record<string, string>;
  url?: string;
};

export function redirectToRobokassa(checkout: RobokassaClientCheckout): boolean {
  if (typeof document === "undefined") return false;

  if (checkout.action && checkout.fields && Object.keys(checkout.fields).length > 0) {
    const form = document.createElement("form");
    form.method = (checkout.method || "POST").toUpperCase() === "GET" ? "GET" : "POST";
    form.action = checkout.action;
    form.acceptCharset = "UTF-8";
    form.style.display = "none";

    for (const [name, value] of Object.entries(checkout.fields)) {
      if (value == null || value === "") continue;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = String(value);
      form.appendChild(input);
    }

    document.body.appendChild(form);
    form.submit();
    return true;
  }

  if (checkout.url) {
    window.location.href = checkout.url;
    return true;
  }

  return false;
}
