'use client';

import { startTransition, useActionState, type FormEvent } from 'react';

export interface FormResult {
  ok?: boolean;
  message?: string;
  error?: string;
  at?: number;
}

/**
 * useActionState, dispatched from onSubmit rather than <form action>, so a
 * refused save does not reset what the person typed (React resets a form
 * after a form action completes). The submit button's name/value is kept.
 */
export function useFormAction(action: (prev: FormResult, form: FormData) => Promise<FormResult>) {
  const [state, dispatch, pending] = useActionState(action, {} as FormResult);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const fd = new FormData(e.currentTarget, submitter ?? undefined);
    startTransition(() => dispatch(fd));
  }
  return { state, pending, onSubmit };
}
