import React from "react";
import ReactDOM from "react-dom/client";
import { CssBaseline } from "@mui/material";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import App from "./App";
import "./styles.css";

const theme = createTheme({
  palette: {
    primary: {
      main: "#2f5d50",
      dark: "#244a40",
      light: "#e2efe9"
    },
    secondary: {
      main: "#c47c35",
      light: "#f5e2cf"
    },
    background: {
      default: "#edf4ef",
      paper: "rgba(255, 252, 246, 0.92)"
    },
    success: {
      main: "#2f7d57"
    },
    error: {
      main: "#b34141"
    },
    text: {
      primary: "#1f2a21",
      secondary: "#5b6d60"
    }
  },
  shape: {
    borderRadius: 20
  },
  typography: {
    fontFamily: '"Avenir Next", "Segoe UI", sans-serif',
    h1: {
      fontSize: "2.1rem",
      fontWeight: 700
    },
    h2: {
      fontSize: "1.55rem",
      fontWeight: 700
    },
    h3: {
      fontSize: "1.1rem",
      fontWeight: 700
    }
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backdropFilter: "blur(14px)",
          boxShadow: "0 18px 42px rgba(48, 68, 47, 0.08)"
        }
      }
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 999,
          paddingInline: 18,
          textTransform: "none",
          fontWeight: 700
        }
      }
    },
    MuiAlert: {
      styleOverrides: {
        root: {
          borderRadius: 16
        }
      }
    },
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: "none",
          minHeight: 44,
          fontWeight: 700
        }
      }
    }
  }
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
