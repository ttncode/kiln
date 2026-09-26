<?php
defined('BASEPATH') or exit('No direct script access allowed');

class Products extends CI_Controller
{
    public function index()
    {
        $this->load->model('Products_model');
        $store_id = (int) $this->session->userdata('store_id');
        $genre = $this->input->get('genre');
        $rows = $genre === null
            ? $this->Products_model->find_by_store($store_id)
            : $this->Products_model->find_by_genre($genre, $store_id);
        $this->output->set_content_type('application/json')->set_output(json_encode($rows));
    }
}
