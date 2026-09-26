<?php
defined('BASEPATH') or exit('No direct script access allowed');

class Products_model extends CI_Model
{
    public function find_by_store($store_id)
    {
        return $this->db->where('store_id', (int) $store_id)->where('deleted_at IS NULL', null, false)->get('products')->result_array();
    }
}
