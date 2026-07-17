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
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: 16,
          background:
            "linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(248, 243, 233, 0.96))",
          transition:
            "box-shadow 140ms ease, border-color 140ms ease, background-color 140ms ease",
          "& .MuiOutlinedInput-notchedOutline": {
            borderColor: "rgba(47, 93, 80, 0.18)"
          },
          "&:hover .MuiOutlinedInput-notchedOutline": {
            borderColor: "rgba(47, 93, 80, 0.34)"
          },
          "&.Mui-focused": {
            boxShadow:
              "0 0 0 4px rgba(196, 124, 53, 0.14), 0 14px 30px rgba(36, 74, 49, 0.08)"
          },
          "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
            borderColor: "#2f5d50",
            borderWidth: 1
          }
        },
        input: {
          paddingBlock: 14
        }
      }
    },
    MuiInputLabel: {
      styleOverrides: {
        root: {
          color: "#5b6d60",
          fontWeight: 600
        },
        shrink: {
          color: "#2f5d50"
        }
      }
    },
    MuiSelect: {
      styleOverrides: {
        select: {
          display: "flex",
          alignItems: "center",
          minHeight: "unset"
        },
        icon: {
          color: "#2f5d50",
          right: 14
        }
      }
    },
    MuiMenu: {
      styleOverrides: {
        paper: {
          marginTop: 8,
          border: "1px solid rgba(47, 93, 80, 0.12)",
          borderRadius: 18,
          background:
            "linear-gradient(180deg, rgba(255, 252, 246, 0.98), rgba(244, 237, 224, 0.98))",
          backdropFilter: "blur(16px)",
          boxShadow: "0 20px 42px rgba(36, 74, 49, 0.14)"
        },
        list: {
          padding: 8
        }
      }
    },
    MuiMenuItem: {
      styleOverrides: {
        root: {
          borderRadius: 12,
          marginBlock: 2,
          paddingBlock: 10,
          "&:hover": {
            backgroundColor: "rgba(47, 93, 80, 0.08)"
          },
          "&.Mui-selected": {
            backgroundColor: "rgba(47, 93, 80, 0.12)"
          },
          "&.Mui-selected:hover": {
            backgroundColor: "rgba(47, 93, 80, 0.16)"
          }
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
