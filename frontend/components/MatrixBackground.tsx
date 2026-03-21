"use client";

import { useEffect, useRef } from "react";

export function MatrixBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    function resize() {
      canvas!.width = window.innerWidth;
      canvas!.height = window.innerHeight;
    }
    resize();
    window.addEventListener("resize", resize);

    const fontSize = 14;
    let columns = Math.floor(canvas.width / fontSize);
    let drops = Array(columns).fill(1);
    const mouse = { x: canvas.width / 2, y: canvas.height / 2 };

    const handleMove = (e: MouseEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    };
    document.addEventListener("mousemove", handleMove);

    const chars = "01";

    const draw = () => {
      if (!ctx) return;
      ctx.fillStyle = "rgba(0,0,0,0.08)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.font = `${fontSize}px JetBrains Mono, monospace`;

      for (let i = 0; i < drops.length; i++) {
        const char = chars[Math.floor(Math.random() * chars.length)];
        const x = i * fontSize;
        const y = drops[i] * fontSize;
        const dx = mouse.x - x;
        const dy = mouse.y - y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const maxDistance = 200;
        const influence = Math.max(0, 1 - distance / maxDistance);

        const r = Math.floor(influence * 0);
        const g = Math.floor(255 - influence * 0);
        const b = Math.floor(influence * 255);
        const alpha = 0.8 + influence * 0.2;

        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.fillText(char, x, y);

        if (y > canvas.height && Math.random() > 0.975 + influence * 0.024) {
          drops[i] = 0;
        }
        drops[i] += 0.5 + influence * 0.5;
      }
    };

    const interval = window.setInterval(draw, 50);

    return () => {
      window.removeEventListener("resize", resize);
      document.removeEventListener("mousemove", handleMove);
      window.clearInterval(interval);
    };
  }, []);

  return <canvas ref={canvasRef} className="matrix-canvas" />;
}