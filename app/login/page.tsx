"use client";

import { MotionConfig, motion } from "motion/react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  LoaderCircle,
  Network,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import "./login.css";
import { safeReturnTo } from "@/lib/navigation";

function returnDestination() {
  const target = new URLSearchParams(window.location.search).get("returnTo");
  return safeReturnTo(target, window.location.origin);
}

function Logo() {
  return (
    <Link className="login-logo" href="/" aria-label="RelayForge home">
      <span className="login-logo-mark" aria-hidden="true">
        <span />
      </span>
      <span>RelayForge</span>
    </Link>
  );
}

export default function LoginPage() {
  const [registering, setRegistering] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setError("");
    setSubmitting(true);
    try {
      const response = await fetch(
        registering ? "/api/auth/register" : "/api/auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim(), password }),
        },
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        const message =
          body &&
          typeof body === "object" &&
          "error" in body &&
          typeof body.error === "string"
            ? body.error
            : "Your request could not be completed. Please try again.";
        throw new Error(message);
      }
      window.location.assign(returnDestination());
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to connect. Please try again.",
      );
      setSubmitting(false);
    }
  };
  const switchMode = () => {
    setRegistering((value) => !value);
    setError("");
    setPassword("");
    setShowPassword(false);
  };

  return (
    <MotionConfig reducedMotion="user">
      <main className="login-page">
        <section className="login-story" aria-labelledby="login-story-title">
          <Logo />
          <motion.div
            className="login-story-content"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="login-copy">
              <div className="login-eyebrow">
                <span /> RELIABILITY, WITHOUT THE GUESSWORK
              </div>
              <h1 id="login-story-title">
                Every event tracked.
                <br />
                <em>Every attempt visible.</em>
              </h1>
              <p>
                Send, inspect, and replay events. Explore durable queues, signed
                delivery, and retries in your own reliability lab.
              </p>
            </div>
            <div className="login-flow-card" aria-label="Example delivery flow">
              <div className="login-flow-head">
                <span>Event delivery flow</span>
                <span className="login-example">
                  <i />
                  EXAMPLE
                </span>
              </div>
              <div className="login-flow-line">
                <div className="login-flow-node">
                  <Zap size={20} />
                  <span>
                    invoice.paid<small>Event accepted</small>
                  </span>
                </div>
                <div className="login-flow-track" aria-hidden="true">
                  <span />
                  <ChevronRight size={16} />
                </div>
                <div className="login-flow-node">
                  <Network size={20} />
                  <span>
                    Billing API<small>200 · 184 ms</small>
                  </span>
                </div>
              </div>
              <div className="login-flow-foot">
                <span>
                  <Check size={15} /> Delivered on first attempt
                </span>
                <code>evt_example_1042</code>
              </div>
            </div>
          </motion.div>
          <p className="login-story-note">
            Break it. Watch it recover. Understand why.
          </p>
        </section>
        <section className="login-form-side" aria-labelledby="login-title">
          <div className="login-mobile-logo">
            <Logo />
          </div>
          <motion.form
            className="login-form"
            onSubmit={submit}
            aria-busy={submitting}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.1 }}
          >
            <div className="login-heading">
              <span className="login-kicker">
                {registering ? "START BUILDING" : "WELCOME BACK"}
              </span>
              <h2 id="login-title">
                {registering
                  ? "Create your workspace"
                  : "Sign in to RelayForge"}
              </h2>
              <p>
                {registering
                  ? "Your events. Your experiments. Your workspace."
                  : "Pick up where your events left off."}
              </p>
            </div>
            <div className="login-field">
              <label htmlFor="login-email">Email address</label>
              <input
                id="login-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                maxLength={254}
                required
                disabled={submitting}
              />
            </div>
            <div className="login-field">
              <label htmlFor="login-password">Password</label>
              <div className="login-password">
                <input
                  id="login-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete={
                    registering ? "new-password" : "current-password"
                  }
                  placeholder={
                    registering
                      ? "At least 12 characters"
                      : "Enter your password"
                  }
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={registering ? 12 : undefined}
                  maxLength={128}
                  required
                  disabled={submitting}
                  aria-describedby={
                    registering ? "login-password-hint" : undefined
                  }
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  disabled={submitting}
                >
                  {showPassword ? <EyeOff size={19} /> : <Eye size={19} />}
                </button>
              </div>
              {registering && (
                <span className="login-field-hint" id="login-password-hint">
                  Use a unique password with 12–128 characters.
                </span>
              )}
            </div>
            {error && (
              <div
                className="login-error"
                ref={errorRef}
                role="alert"
                tabIndex={-1}
              >
                {error}
              </div>
            )}
            <button
              className="login-submit"
              type="submit"
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <LoaderCircle size={18} className="login-spinner" />{" "}
                  {registering ? "Creating your workspace…" : "Signing in…"}
                </>
              ) : (
                <>
                  {registering ? "Create account" : "Sign in"}
                  <ArrowRight size={18} />
                </>
              )}
            </button>
            <p className="login-switch">
              {registering ? "Already have an account?" : "New to RelayForge?"}{" "}
              <button type="button" onClick={switchMode} disabled={submitting}>
                {registering ? "Sign in" : "Create an account"}
              </button>
            </p>
            <div className="login-security">
              <ShieldCheck size={16} />
              <span>Password protected. Workspace isolated.</span>
            </div>
          </motion.form>
        </section>
      </main>
    </MotionConfig>
  );
}
