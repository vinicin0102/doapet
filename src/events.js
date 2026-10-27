// Server-Sent Events: avisa as páginas abertas assim que o progresso muda,
// para que a barra pública seja atualizada imediatamente após salvar.

export class ProgressBroadcaster {
  constructor() {
    this.clients = new Set();
    // Comentário periódico mantém a conexão viva atrás de proxies.
    this.heartbeat = setInterval(() => this.#write(': ping\n\n'), 25_000);
    this.heartbeat.unref();
  }

  subscribe(req, res, initialData) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 5000\n\n');
    res.write(`event: progresso\ndata: ${JSON.stringify(initialData)}\n\n`);
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  publish(data) {
    this.#write(`event: progresso\ndata: ${JSON.stringify(data)}\n\n`);
  }

  #write(chunk) {
    for (const res of this.clients) res.write(chunk);
  }

  close() {
    clearInterval(this.heartbeat);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}
