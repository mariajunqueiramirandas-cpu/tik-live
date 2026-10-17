import { PRODUCT_NAME } from "@tik-live/shared";
import { isRouteErrorResponse, useRouteError } from "react-router";
import { ApiError } from "../lib/api";
import { signInUrl } from "../lib/config";
import { ButtonLink, Button } from "../ui/Button";
import { Empty } from "../ui/Display";

/** Per-route error boundary: one failing screen never blanks the app. */
export function RouteError() {
  const error = useRouteError();
  if (error instanceof ApiError && error.status === 404) {
    return (
      <div style={{ padding: "var(--s-8)" }}>
        <Empty title="Esse apresentador não existe" action={<ButtonLink to="/app">Voltar para seus apresentadores</ButtonLink>}>
          <p>Ele pode ter sido excluído, ou o link está errado.</p>
        </Empty>
      </div>
    );
  }
  if (error instanceof ApiError && error.status === 401) {
    const url = signInUrl();
    return (
      <div style={{ padding: "var(--s-8)" }}>
        <Empty title="Entre para continuar" action={url ? <Button onClick={() => location.assign(url)}>Entrar</Button> : <Button onClick={() => location.reload()}>Tentar de novo</Button>}>
          <p>Sua sessão terminou. Entre de novo para continuar de onde parou.</p>
        </Empty>
      </div>
    );
  }
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Algo deu errado.";
  const stale = error instanceof Error && /dynamically imported module|Importing a module script failed/i.test(error.message);
  return (
    <div style={{ padding: "var(--s-8)" }}>
      <Empty
        title={stale ? "Tem uma versão nova" : "Esta tela não carregou"}
        action={<Button onClick={() => location.reload()}>{stale ? "Recarregar" : "Tentar de novo"}</Button>}
      >
        <p>{stale ? `${PRODUCT_NAME} foi atualizado enquanto esta aba estava aberta.` : message}</p>
      </Empty>
    </div>
  );
}

export function NotFound() {
  return (
    <div style={{ padding: "var(--s-8)" }}>
      <Empty title="Não tem nada aqui" action={<ButtonLink to="/app">Voltar para seus apresentadores</ButtonLink>}>
        <p>Essa página não existe.</p>
      </Empty>
    </div>
  );
}
