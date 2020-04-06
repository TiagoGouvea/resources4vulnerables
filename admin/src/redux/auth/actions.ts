import { createAction } from '@reduxjs/toolkit';
import { TokenResponse } from '../../interfaces/auth';
import { ThunkResult } from '../store';
import { backend, setAuthorization } from '../../utils/networking';

// Simple actions and types
export const doLoginUser = createAction<void>('auth/LOGIN_USER');
export const doLoginUserSuccess = createAction<TokenResponse>('auth/LOGIN_USER_SUCCESS');
export const doLoginUserFailed = createAction<Error | undefined>('auth/LOGIN_USER_FAILED');
export const doGetToken = createAction<void>('auth/GET_TOKEN');
export const doGetTokenSuccess = createAction<TokenResponse>('auth/GET_TOKEN_SUCCESS');
export const doGetTokenFailed = createAction<Error | undefined>('auth/GET_TOKEN_FAILED');

/**
 * Login user thunk action
 */
export const requestLoginUser = (email: string, password: string): ThunkResult<void> => {
  return async (dispatch) => {
    try {
      // Start request - starting loading state
      dispatch(doLoginUser());
      const response = await backend.post<TokenResponse>('/auth/login', { email, password });
      if (response && response.data) {
        // Request finished
        setAuthorization(response.data.token); // Set base authorization
        dispatch(doLoginUserSuccess(response.data)); // Dispatch result
      } else {
        // Request without response - probably won't happen, but cancel the request
        dispatch(doLoginUserFailed());
      }
    } catch (error) {
      // Request failed: dispatch error
      dispatch(doLoginUserFailed(error));
    }
  };
};

/**
 * Token renewal process - call on token expiration and on the return to the app
 */
export const requestGetToken = (): ThunkResult<void> => {
  return async (dispatch, getState) => {
    try {
      // Start request - starting loading state
      dispatch(doGetToken());
      // Getting refresh token from the state
      const refreshToken = getState().authReducer.refreshToken;
      if (!refreshToken) {
        // User never logged
        dispatch(doGetTokenFailed());
        return;
      }
      const response = await backend.post<TokenResponse>('/auth/token', { refreshToken });
      if (response && response.data) {
        // Request finished
        setAuthorization(response.data.token); // Set base authorization
        dispatch(doGetTokenSuccess(response.data)); // Dispatch result
      } else {
        // Request without response - probably won't happen, but cancel the request
        dispatch(doGetTokenFailed());
      }
    } catch (error) {
      // Request failed: dispatch error
      dispatch(doGetTokenFailed(error));
    }
  };
};