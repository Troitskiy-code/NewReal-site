import toast from "react-hot-toast";

const BASE_STYLE = {
  background: "#1A1A1A",
  borderRadius: "12px",
  padding: "12px 20px",
} as const;

export const showSuccess = (message: string, duration = 3000) => {
  return toast.success(message, {
    style: {
      ...BASE_STYLE,
      border: "1px solid #4CAF50",
      color: "#E8F5E9",
    },
    duration,
    icon: "✅",
  });
};

export const showError = (message: string, duration = 4000) => {
  return toast.error(message, {
    style: {
      ...BASE_STYLE,
      border: "1px solid #F44336",
      color: "#FFCDD2",
    },
    duration,
    icon: "❌",
  });
};

export const showInfo = (message: string, duration = 2000) => {
  return toast(message, {
    style: {
      ...BASE_STYLE,
      border: "1px solid #6C63FF",
      color: "#D1C4E9",
    },
    duration,
    icon: "ℹ️",
  });
};

export const showLoading = (message: string) => {
  return toast.loading(message, {
    style: {
      ...BASE_STYLE,
      border: "1px solid #FFA726",
      color: "#FFF3E0",
    },
  });
};

export const dismissToast = (id?: string) => {
  toast.dismiss(id);
};
