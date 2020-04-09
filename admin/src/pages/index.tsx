import React from 'react';
import { BrowserRouter, Switch, Route } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { AppState } from '../redux/rootReducer';
import { User } from '../interfaces/user';
import { AdminLayout } from '../components/adminLayout';

// Pages
import { LoginPage } from './login';
import { DashboardPage } from './dashboard';
import { PlaceList } from './places/list';
import { PlaceForm } from './places/form';
import { useRefreshToken } from '../utils/auth';
import { LogoutPage } from './logout';
import { BenefitList } from './benefits/list';
import { BenefitForm } from './benefits/form';
import { PlaceStoreList } from './placeStore/list';
import { PlaceStoreForm } from './placeStore/form';

/**
 * Router available only for logged users
 * @param props component props
 */
const PrivateRouter: React.FC<{}> = (props) => {
  const loading = useRefreshToken();

  return (
    <AdminLayout loading={loading}>
      <>
        <Route path="/logout" component={LogoutPage} />
        {/* Place routes */}
        <Route path="/estabelecimentos" component={PlaceList} />
        <Route path="/estabelecimentos/:id" component={PlaceForm} />
        {/* Benefit routes */}
        <Route path="/beneficios" component={BenefitList} />
        <Route path="/beneficios/:id" component={BenefitForm} />
        {/* Store routes */}
        <Route path="/lojas" component={PlaceStoreList} />
        <Route path="/lojas/:id" component={PlaceStoreForm} />
        {/* Dashboard */}
        <Route path="/" component={DashboardPage} exact />
      </>
    </AdminLayout>
  );
};

/**
 * Router available when the user is not logged
 * @param props component props
 */
const PublicRouter: React.FC<{}> = (props) => {
  return (
    <Switch>
      <Route path="*">
        <LoginPage />
      </Route>
    </Switch>
  );
};

/**
 * Router component
 * @param props router props
 */
export const Router: React.FC<{}> = (props) => {
  const user = useSelector<AppState, User | undefined>((state) => state.authReducer.user);

  return (
    <BrowserRouter>
      {user && user.role === 'admin' ? <PrivateRouter {...props} /> : <PublicRouter {...props} />}
    </BrowserRouter>
  );
};
